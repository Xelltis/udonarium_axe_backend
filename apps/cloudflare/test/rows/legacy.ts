import type { ObjectContext } from '../../contracts/protocol';
import { encodeData } from '../../src/core/rooms/codec';
import { describe } from '../../src/core/rooms/visibility';

// A room as the store wrote it before pages: a row for each object, chunks for big ones, and a row for
// each tombstone. The store packs such a room into pages the first time it is opened.

const LEGACY_CHUNK_BYTES = 1024 * 1024;

export const writeLegacyRoom = (
  sql: SqlStorage,
  objects: { context: ObjectContext; owner?: string | null }[],
  tombstones: string[] = []
): void => {
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
  for (const { context, owner = null } of objects) {
    const data = encodeData(context.syncData);
    const chunks = data.byteLength > LEGACY_CHUNK_BYTES ? Math.ceil(data.byteLength / LEGACY_CHUNK_BYTES) : 0;
    const { parent, view } = describe(context);
    sql.exec(
      `INSERT INTO objects (identifier, alias, major, minor, owner, parent, view, chunks, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      sql.exec(
        'INSERT INTO object_chunks (identifier, seq, data) VALUES (?, ?, ?)',
        context.identifier,
        seq,
        data.slice(seq * LEGACY_CHUNK_BYTES, (seq + 1) * LEGACY_CHUNK_BYTES)
      );
    }
  }
  tombstones.forEach((identifier, index) =>
    sql.exec('INSERT INTO tombstones (identifier, deleted_at) VALUES (?, ?)', identifier, index)
  );
};
