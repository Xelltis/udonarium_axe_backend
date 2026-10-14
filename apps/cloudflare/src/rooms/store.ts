import type { CatalogItem, ObjectContext } from '../../contracts/protocol';
import { decodeData, encodeData } from './codec';

/**
 * SQLite の1行は 2MB まで。syncData の上限が無いもの（白板の場面など）は、これより大きければ
 * object_chunks に分けて置く
 */
export const CHUNK_BYTES = 1024 * 1024;

/** 版と持ち主だけの、メモリに置く索引 */
export interface StoredEntry {
  alias: string;
  majorVersion: number;
  minorVersion: number;
  /** 接続しているあいだだけ置くもの（PeerCursor）なら、その人のピア ID。それ以外は null */
  owner: string | null;
}

/** まだ書いていない変更。undefined の項目は変えない */
interface PendingWrite {
  /** 置く中身。null なら行を消す */
  context?: ObjectContext | null;
  owner?: string | null;
  /** true なら tombstone を置き、false なら消す */
  tombstone?: boolean;
}

/** 部屋のテーブル。部屋を作るときに作り、部屋を消すときに deleteAll で丸ごと消える */
export const migrate = (sql: SqlStorage): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS objects (
    identifier TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    major REAL NOT NULL,
    minor REAL NOT NULL,
    owner TEXT,
    chunks INTEGER NOT NULL DEFAULT 0,
    data BLOB
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS object_chunks (
    identifier TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (identifier, seq)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS tombstones (
    identifier TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  )`);
};

/**
 * 部屋のオブジェクトを持つ。
 *
 * 版と tombstone は初めて要るときに SQLite から読んでメモリに置き、中身は答えるときにだけ読む。
 * 書き込みは識別子ごとにまとめておき、flush でまとめて書く。ドラッグのように同じものが何度も
 * 書き換わっても、書く行は1つで済む。
 */
export class RoomStore {
  private entries: Map<string, StoredEntry> | null = null;
  private tombstones: Set<string> | null = null;
  private readonly pending = new Map<string, PendingWrite>();

  constructor(private readonly storage: DurableObjectStorage) {}

  private get index(): Map<string, StoredEntry> {
    this.entries ??= new Map(
      this.storage.sql
        .exec<{
          identifier: string;
          alias: string;
          major: number;
          minor: number;
          owner: string | null;
        }>('SELECT identifier, alias, major, minor, owner FROM objects')
        .toArray()
        .map((row) => [
          row.identifier,
          { alias: row.alias, majorVersion: row.major, minorVersion: row.minor, owner: row.owner },
        ]),
    );
    return this.entries;
  }

  private get deleted(): Set<string> {
    this.tombstones ??= new Set(
      this.storage.sql
        .exec<{ identifier: string }>('SELECT identifier FROM tombstones')
        .toArray()
        .map((row) => row.identifier),
    );
    return this.tombstones;
  }

  entryOf(identifier: string): StoredEntry | null {
    return this.index.get(identifier) ?? null;
  }

  isDeleted(identifier: string): boolean {
    return this.deleted.has(identifier);
  }

  /** 持っているものすべての識別子と版 */
  catalog(): CatalogItem[] {
    return Array.from(this.index, ([identifier, entry]) => ({
      identifier,
      version: entry.majorVersion + entry.minorVersion,
    }));
  }

  /** 中身まで揃えたもの。持っていなければ null */
  get(identifier: string): ObjectContext | null {
    const entry = this.index.get(identifier);
    if (!entry) return null;
    const waiting = this.pending.get(identifier)?.context;
    if (waiting) return waiting;
    return {
      aliasName: entry.alias,
      identifier,
      majorVersion: entry.majorVersion,
      minorVersion: entry.minorVersion,
      syncData: this.readData(identifier) as Record<string, unknown>,
    };
  }

  private readData(identifier: string): unknown {
    const row = this.storage.sql
      .exec<{ chunks: number; data: ArrayBuffer | null }>(
        'SELECT chunks, data FROM objects WHERE identifier = ?',
        identifier,
      )
      .one();
    if (row.chunks === 0) return decodeData(new Uint8Array(row.data as ArrayBuffer));
    const parts = this.storage.sql
      .exec<{ data: ArrayBuffer }>(
        'SELECT data FROM object_chunks WHERE identifier = ? ORDER BY seq',
        identifier,
      )
      .toArray()
      .map((part) => new Uint8Array(part.data));
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return decodeData(bytes);
  }

  put(context: ObjectContext, owner: string | null): void {
    this.index.set(context.identifier, {
      alias: context.aliasName,
      majorVersion: context.majorVersion,
      minorVersion: context.minorVersion,
      owner,
    });
    this.stage(context.identifier, { context, owner });
  }

  /** 持っているものを消す。tombstone を置けば、同じ識別子をもう受けない */
  delete(identifier: string, tombstone: boolean): void {
    this.index.delete(identifier);
    this.stage(identifier, { context: null });
    if (tombstone) {
      this.deleted.add(identifier);
      this.stage(identifier, { tombstone: true });
    }
  }

  /** tombstone を外し、同じ識別子をまた受けるようにする */
  forget(identifiers: readonly string[]): void {
    for (const identifier of identifiers) {
      if (this.deleted.delete(identifier)) this.stage(identifier, { tombstone: false });
    }
  }

  /** その人のあいだだけ置いているもの（その人のカーソル）の識別子 */
  ownedBy(peerId: string): string[] {
    return [...this.index].filter(([, entry]) => entry.owner === peerId).map(([id]) => id);
  }

  /** その人が出たので、その人のあいだだけ置いていたものを消す。消した識別子を返す */
  removeOwnedBy(peerId: string): string[] {
    const owned = this.ownedBy(peerId);
    for (const identifier of owned) this.delete(identifier, false);
    return owned;
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  private stage(identifier: string, write: PendingWrite): void {
    this.pending.set(identifier, { ...this.pending.get(identifier), ...write });
  }

  /** まとめておいた変更を1つのトランザクションで書く。書いた識別子の数を返す */
  flush(): number {
    const count = this.pending.size;
    const sql = this.storage.sql;
    this.storage.transactionSync(() => {
      for (const [identifier, write] of this.pending) {
        if (write.context !== undefined) {
          sql.exec('DELETE FROM object_chunks WHERE identifier = ?', identifier);
          if (write.context === null) {
            sql.exec('DELETE FROM objects WHERE identifier = ?', identifier);
          } else {
            this.writeObject(write.context, write.owner ?? null);
          }
        }
        if (write.tombstone === true) {
          sql.exec(
            'INSERT OR REPLACE INTO tombstones (identifier, deleted_at) VALUES (?, ?)',
            identifier,
            Date.now(),
          );
        } else if (write.tombstone === false) {
          sql.exec('DELETE FROM tombstones WHERE identifier = ?', identifier);
        }
      }
    });
    this.pending.clear();
    return count;
  }

  private writeObject(context: ObjectContext, owner: string | null): void {
    const sql = this.storage.sql;
    const data = encodeData(context.syncData);
    const chunks = data.byteLength > CHUNK_BYTES ? Math.ceil(data.byteLength / CHUNK_BYTES) : 0;
    sql.exec(
      `INSERT OR REPLACE INTO objects (identifier, alias, major, minor, owner, chunks, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      context.identifier,
      context.aliasName,
      context.majorVersion,
      context.minorVersion,
      owner,
      chunks,
      chunks === 0 ? data : null,
    );
    for (let seq = 0; seq < chunks; seq++) {
      sql.exec(
        'INSERT INTO object_chunks (identifier, seq, data) VALUES (?, ?, ?)',
        context.identifier,
        seq,
        data.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES),
      );
    }
  }
}
