import type { ObjectContext } from '../../contracts/protocol';
import { decodeData, encodeData } from '../core/rooms/codec';
import { ObjectIndex } from '../core/rooms/object-index';
import type { PendingWrite, StoredEntry, TombstoneLimits } from '../core/rooms/object-index';
import { describe } from '../core/rooms/visibility';
import type { View } from '../core/rooms/visibility';

/**
 * SQLite の1行は 2MB まで。syncData の上限が無いもの（白板の場面など）は、これより大きければ
 * object_chunks に分けて置く
 */
export const CHUNK_BYTES = 1024 * 1024;

/** 部屋のテーブル。部屋を作るときに作り、部屋を消すときに deleteAll で丸ごと消える */
export const migrate = (sql: SqlStorage): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS objects (
    identifier TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    major REAL NOT NULL,
    minor REAL NOT NULL,
    owner TEXT,
    parent TEXT NOT NULL DEFAULT '',
    view TEXT,
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

/** 部屋のオブジェクトを、Durable Object の SQLite に置く */
export class RoomStore extends ObjectIndex {
  constructor(
    private readonly storage: DurableObjectStorage,
    tombstoneLimits?: TombstoneLimits,
  ) {
    super(tombstoneLimits);
  }

  protected loadEntries(): [string, StoredEntry][] {
    return this.indexRows().map((row) => [row.identifier, entryOf(row)]);
  }

  protected storedEntry(identifier: string): StoredEntry | null {
    const [row] = this.indexRows(identifier);
    return row ? entryOf(row) : null;
  }

  /** 索引に置く列。identifier を渡せば、その1行だけ */
  private indexRows(identifier?: string): IndexRow[] {
    const columns = 'SELECT identifier, alias, major, minor, owner, parent, view FROM objects';
    return identifier === undefined
      ? this.storage.sql.exec<IndexRow>(columns).toArray()
      : this.storage.sql.exec<IndexRow>(`${columns} WHERE identifier = ?`, identifier).toArray();
  }

  protected loadTombstones(): string[] {
    return this.storage.sql
      .exec<{ identifier: string }>('SELECT identifier FROM tombstones')
      .toArray()
      .map((row) => row.identifier);
  }

  protected storedTombstone(identifier: string): boolean {
    return (
      this.storage.sql.exec('SELECT 1 FROM tombstones WHERE identifier = ?', identifier).toArray()
        .length > 0
    );
  }

  protected readData(identifier: string): unknown {
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

  /**
   * まとめておいた変更を1つのトランザクションで書く。SQLite が書いた行の数（索引の行も入る）を返す。
   * 無料枠でいちばん先に尽きるのが書いた行の数なので、見積もりと比べられるよう、識別子ではなく行で数える。
   *
   * 1つでも書けないもの（SQLite の1行の上限を超えたものなど）があると、トランザクションごと戻る。
   * そのときは1つずつ書き直し、書けないものだけを捨てて、その索引を SQLite に合わせて戻す。捨てないと、
   * 次からも同じところで止まり、何も残らなくなる
   */
  flush(): number {
    let rows = 0;
    try {
      rows = this.storage.transactionSync(() => {
        let written = 0;
        for (const [identifier, write] of this.pending)
          written += this.writePending(identifier, write);
        return written;
      });
    } catch {
      for (const [identifier, write] of this.pending) {
        try {
          rows += this.storage.transactionSync(() => this.writePending(identifier, write));
        } catch (err) {
          console.error('Could not keep an object:', identifier, err);
          this.resync(identifier);
        }
      }
    }
    this.pending.clear();
    this.pruneTombstones();
    return rows;
  }

  /** 書いた行の数を返す */
  private writePending(identifier: string, write: PendingWrite): number {
    let rows = 0;
    if (write.context !== undefined) {
      rows += this.run('DELETE FROM object_chunks WHERE identifier = ?', identifier);
      if (write.context === null) {
        rows += this.run('DELETE FROM objects WHERE identifier = ?', identifier);
      } else {
        rows += this.writeObject(write.context, write.owner ?? null);
      }
    }
    if (write.tombstone === true) {
      rows += this.run(
        'INSERT OR REPLACE INTO tombstones (identifier, deleted_at) VALUES (?, ?)',
        identifier,
        Date.now(),
      );
    } else if (write.tombstone === false) {
      rows += this.run('DELETE FROM tombstones WHERE identifier = ?', identifier);
    }
    return rows;
  }

  /** 書く文を最後まで流し、書いた行の数を返す */
  private run(query: string, ...bindings: SqlStorageValue[]): number {
    const cursor = this.storage.sql.exec(query, ...bindings);
    cursor.toArray();
    return cursor.rowsWritten;
  }

  /** 消した印が多すぎれば、古いものから減らす */
  private pruneTombstones(): void {
    const over = this.tombstonesOver();
    if (over === 0) return;
    const sql = this.storage.sql;
    const oldest = sql
      .exec<{ identifier: string }>(
        'SELECT identifier FROM tombstones ORDER BY deleted_at LIMIT ?',
        over,
      )
      .toArray();
    for (const { identifier } of oldest) {
      sql.exec('DELETE FROM tombstones WHERE identifier = ?', identifier);
      (this.tombstones as Set<string>).delete(identifier);
    }
  }

  /** 書いた行の数を返す */
  private writeObject(context: ObjectContext, owner: string | null): number {
    const data = encodeData(context.syncData);
    const chunks = data.byteLength > CHUNK_BYTES ? Math.ceil(data.byteLength / CHUNK_BYTES) : 0;
    const { parent, view } = describe(context);
    let rows = this.run(
      `INSERT OR REPLACE INTO objects
         (identifier, alias, major, minor, owner, parent, view, chunks, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      context.identifier,
      context.aliasName,
      context.majorVersion,
      context.minorVersion,
      owner,
      parent,
      view === null ? null : JSON.stringify(view),
      chunks,
      chunks === 0 ? data : null,
    );
    for (let seq = 0; seq < chunks; seq++) {
      rows += this.run(
        'INSERT INTO object_chunks (identifier, seq, data) VALUES (?, ?, ?)',
        context.identifier,
        seq,
        data.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES),
      );
    }
    return rows;
  }
}

interface IndexRow extends Record<string, SqlStorageValue> {
  identifier: string;
  alias: string;
  major: number;
  minor: number;
  owner: string | null;
  parent: string;
  view: string | null;
}

const entryOf = (row: IndexRow): StoredEntry => ({
  alias: row.alias,
  majorVersion: row.major,
  minorVersion: row.minor,
  owner: row.owner,
  parent: row.parent,
  view: row.view === null ? null : (JSON.parse(row.view) as View),
});
