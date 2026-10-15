import type { CatalogItem, ObjectContext } from '../../contracts/protocol';
import { decodeData, encodeData } from './codec';
import { describe } from './visibility';
import type { View, ViewEntry } from './visibility';

/**
 * SQLite の1行は 2MB まで。syncData の上限が無いもの（白板の場面など）は、これより大きければ
 * object_chunks に分けて置く
 */
export const CHUNK_BYTES = 1024 * 1024;

/** 消した印をこれより多くは置かない。超えたら古いものから PRUNED_TOMBSTONES まで減らす */
export const MAX_TOMBSTONES = 100_000;
export const PRUNED_TOMBSTONES = 80_000;

/** 版・持ち主・親・見え方の手がかりだけの、メモリに置く索引 */
export interface StoredEntry extends ViewEntry {
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

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly tombstoneLimits = { most: MAX_TOMBSTONES, prunedTo: PRUNED_TOMBSTONES },
  ) {}

  private get index(): Map<string, StoredEntry> {
    return this.load();
  }

  /** 索引を、初めて要るときに SQLite から読む */
  private load(): Map<string, StoredEntry> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    for (const row of this.indexRows()) this.remember(row.identifier, entryOf(row));
    return this.entries;
  }

  /** 索引に置く列。identifier を渡せば、その1行だけ */
  private indexRows(identifier?: string): IndexRow[] {
    const columns = 'SELECT identifier, alias, major, minor, owner, parent, view FROM objects';
    return identifier === undefined
      ? this.storage.sql.exec<IndexRow>(columns).toArray()
      : this.storage.sql.exec<IndexRow>(`${columns} WHERE identifier = ?`, identifier).toArray();
  }

  /**
   * 書けなかったものの索引を、SQLite にあるとおりに戻す。戻さないと、索引は新しい版のまま中身は古い
   * （または無い）ので、読むと版と中身が食い違うか、中身が見つからずに止まる
   */
  private resync(identifier: string): void {
    const [row] = this.indexRows(identifier);
    if (row) {
      this.remember(identifier, entryOf(row));
    } else {
      this.forgetRelations(identifier);
      this.index.delete(identifier);
    }
    const marked =
      this.storage.sql.exec('SELECT 1 FROM tombstones WHERE identifier = ?', identifier).toArray()
        .length > 0;
    if (marked) this.deleted.add(identifier);
    else this.deleted.delete(identifier);
  }

  /** 親から子へ、発言からリアクションへの引き */
  private readonly children = new Map<string, Set<string>>();
  private readonly followers = new Map<string, Set<string>>();

  /** 索引に置き、親子とリアクションの引きもそろえる */
  private remember(identifier: string, entry: StoredEntry): void {
    this.forgetRelations(identifier);
    (this.entries as Map<string, StoredEntry>).set(identifier, entry);
    if (entry.parent) relate(this.children, entry.parent, identifier);
    if (entry.view?.kind === 'reaction') relate(this.followers, entry.view.message, identifier);
  }

  private forgetRelations(identifier: string): void {
    const entry = this.entries?.get(identifier);
    if (entry?.parent) this.children.get(entry.parent)?.delete(identifier);
    if (entry?.view?.kind === 'reaction')
      this.followers.get(entry.view.message)?.delete(identifier);
  }

  /** 見え方を決めるために、識別子から索引の1行を引く */
  readonly lookup = (identifier: string): StoredEntry | null => this.index.get(identifier) ?? null;

  /**
   * そのオブジェクトの見え方で見え方が変わるもの。子孫（カードの表の絵、タブの発言など）と、
   * 発言へのリアクション
   */
  dependentsOf(identifier: string): string[] {
    return this.reach(identifier, true);
  }

  /** 子孫。親を消すと一緒に消すもの */
  descendantsOf(identifier: string): string[] {
    return this.reach(identifier, false);
  }

  /** いま持っているものすべての識別子 */
  identifiers(): string[] {
    return [...this.load().keys()];
  }

  private reach(identifier: string, withFollowers: boolean): string[] {
    this.load();
    const found = new Set<string>();
    const queue = [identifier];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const next = [
        ...(this.children.get(current) ?? []),
        ...(withFollowers ? (this.followers.get(current) ?? []) : []),
      ];
      for (const id of next) {
        if (id === identifier || found.has(id)) continue;
        found.add(id);
        queue.push(id);
      }
    }
    return [...found];
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

  /** 持っているものの数 */
  get size(): number {
    return this.index.size;
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
    this.load();
    this.remember(context.identifier, {
      alias: context.aliasName,
      majorVersion: context.majorVersion,
      minorVersion: context.minorVersion,
      owner,
      ...describe(context),
    });
    this.stage(context.identifier, { context, owner });
  }

  /** 持っているものを消す。tombstone を置けば、同じ識別子をもう受けない */
  delete(identifier: string, tombstone: boolean): void {
    this.load();
    this.forgetRelations(identifier);
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

  /** その人のあいだだけ置いているものを持っている人のピア ID */
  owners(): string[] {
    const owners = new Set<string>();
    for (const entry of this.index.values()) if (entry.owner !== null) owners.add(entry.owner);
    return [...owners];
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

  /**
   * 消した印が MAX_TOMBSTONES を超えたら、古いものから PRUNED_TOMBSTONES まで減らす。
   * 印はいつまでも残るので、減らさないと、消すたびに増え続ける
   */
  private pruneTombstones(): void {
    if (!this.tombstones || this.tombstones.size <= this.tombstoneLimits.most) return;
    const sql = this.storage.sql;
    const oldest = sql
      .exec<{ identifier: string }>(
        'SELECT identifier FROM tombstones ORDER BY deleted_at LIMIT ?',
        this.tombstones.size - this.tombstoneLimits.prunedTo,
      )
      .toArray();
    for (const { identifier } of oldest) {
      sql.exec('DELETE FROM tombstones WHERE identifier = ?', identifier);
      this.tombstones.delete(identifier);
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

const relate = (relations: Map<string, Set<string>>, from: string, to: string): void => {
  const set = relations.get(from) ?? new Set<string>();
  set.add(to);
  relations.set(from, set);
};
