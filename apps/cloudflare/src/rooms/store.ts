import type { ObjectContext } from '../../contracts/protocol';
import { decodeData, encodeData } from '../core/rooms/codec';
import { ObjectIndex } from '../core/rooms/object-index';
import type { PendingWrite, StoredEntry, TombstoneLimits } from '../core/rooms/object-index';
import { describe } from '../core/rooms/visibility';
import type { View } from '../core/rooms/visibility';

/**
 * A row in SQLite holds up to 2MB. An object whose syncData has no limit (such as a whiteboard scene)
 * is split into object_chunks when it is bigger than this.
 */
export const CHUNK_BYTES = 1024 * 1024;

/** The room's tables. Made when the room is made, and wiped out whole by deleteAll when it is deleted. */
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

/** Keeps a room's objects in the SQLite of a Durable Object. */
export class RoomStore extends ObjectIndex {
  constructor(
    private readonly storage: DurableObjectStorage,
    tombstoneLimits?: TombstoneLimits
  ) {
    super(tombstoneLimits);
  }

  protected loadEntries(): [string, StoredEntry][] {
    return this.indexRows().map((row) => [row.identifier, entryOf(row)]);
  }

  /** The columns kept in the index. Given an identifier, only that one row. */
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

  protected readData(identifier: string): unknown {
    const row = this.storage.sql
      .exec<{ chunks: number; data: ArrayBuffer | null }>(
        'SELECT chunks, data FROM objects WHERE identifier = ?',
        identifier
      )
      .one();
    if (row.chunks === 0) return decodeData(new Uint8Array(row.data as ArrayBuffer));
    const parts = this.storage.sql
      .exec<{ data: ArrayBuffer }>('SELECT data FROM object_chunks WHERE identifier = ? ORDER BY seq', identifier)
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
   * Writes the gathered changes in one transaction. Returns how many rows SQLite wrote (index rows
   * included). Rows written are what runs out first on the free plan, so it counts rows, not
   * identifiers, to compare with the estimate.
   *
   * When even one cannot be written (as when it is over SQLite's limit for a row), the whole
   * transaction rolls back. Then it writes them again one at a time, drops only those that cannot be
   * written, and sets their index back to match SQLite. Without dropping them, every later flush stops
   * at the same place and nothing is kept.
   */
  flush(): number {
    let rows = 0;
    try {
      rows = this.storage.transactionSync(() => {
        let written = 0;
        for (const [identifier, write] of this.pending) written += this.writePending(identifier, write);
        return written;
      });
    } catch {
      for (const [identifier, write] of this.pending) {
        try {
          rows += this.storage.transactionSync(() => this.writePending(identifier, write));
        } catch (err) {
          console.error('Could not keep an object:', identifier, err);
          const [row] = this.indexRows(identifier);
          const marked =
            this.storage.sql.exec('SELECT 1 FROM tombstones WHERE identifier = ?', identifier).toArray().length > 0;
          this.resync(identifier, row ? entryOf(row) : null, marked);
        }
      }
    }
    this.pending.clear();
    this.pruneTombstones();
    return rows;
  }

  /** Returns how many rows it wrote. */
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
        Date.now()
      );
    } else if (write.tombstone === false) {
      rows += this.run('DELETE FROM tombstones WHERE identifier = ?', identifier);
    }
    return rows;
  }

  /** Runs a writing statement through to the end and returns how many rows it wrote. */
  private run(query: string, ...bindings: SqlStorageValue[]): number {
    const cursor = this.storage.sql.exec(query, ...bindings);
    cursor.toArray();
    return cursor.rowsWritten;
  }

  /** When there are too many tombstones, removes the oldest first. */
  private pruneTombstones(): void {
    const over = this.tombstonesOver();
    if (over === 0) return;
    const sql = this.storage.sql;
    const oldest = sql
      .exec<{ identifier: string }>('SELECT identifier FROM tombstones ORDER BY deleted_at LIMIT ?', over)
      .toArray();
    for (const { identifier } of oldest) {
      sql.exec('DELETE FROM tombstones WHERE identifier = ?', identifier);
      (this.tombstones as Set<string>).delete(identifier);
    }
  }

  /**
   * Returns how many rows it wrote. An object already there is updated in place: REPLACE would delete
   * the row and put it back, writing the primary key's index row again too.
   */
  private writeObject(context: ObjectContext, owner: string | null): number {
    const data = encodeData(context.syncData);
    const chunks = data.byteLength > CHUNK_BYTES ? Math.ceil(data.byteLength / CHUNK_BYTES) : 0;
    const { parent, view } = describe(context);
    let rows = this.run(
      `INSERT INTO objects (identifier, alias, major, minor, owner, parent, view, chunks, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (identifier) DO UPDATE SET
         alias = excluded.alias, major = excluded.major, minor = excluded.minor, owner = excluded.owner,
         parent = excluded.parent, view = excluded.view, chunks = excluded.chunks, data = excluded.data`,
      context.identifier,
      context.aliasName,
      context.majorVersion,
      context.minorVersion,
      owner,
      parent,
      view === null ? null : JSON.stringify(view),
      chunks,
      chunks === 0 ? data : null
    );
    for (let seq = 0; seq < chunks; seq++) {
      rows += this.run(
        'INSERT INTO object_chunks (identifier, seq, data) VALUES (?, ?, ?)',
        context.identifier,
        seq,
        data.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES)
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
