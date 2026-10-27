import type { ObjectContext } from '../../contracts/protocol';
import { decodeData, encodeData } from '../core/rooms/codec';
import type { RoomStore as StoreOfRoom } from '../core/rooms/host';
import { ObjectIndex } from '../core/rooms/object-index';
import type { PendingWrite, StoredEntry, TombstoneLimits } from '../core/rooms/object-index';
import { describe } from '../core/rooms/visibility';
import type { View } from '../core/rooms/visibility';
import { LegacyRoomStore } from './legacy-store';

// The room's objects are packed into pages: rows of about PAGE_BYTES holding many objects each. Cloudflare
// bills the rows SQLite reads and writes, not their bytes, so loading a room writes a few hundred rows
// rather than two for every object, and a room that wakes up reads its index in a few hundred rows
// rather than one for every object. A flush rewrites only the pages whose objects changed.

/**
 * A row in SQLite holds up to 2MB. An object bigger than this (such as a whiteboard scene) is split over
 * several rows of blobs.
 */
export const CHUNK_BYTES = 1024 * 1024;
/**
 * About how many bytes of objects one page holds. A flush rewrites a whole page for one object changed
 * in it, so a bigger page writes fewer rows but takes longer to write.
 */
export const PAGE_BYTES = 8 * 1024;
/**
 * An object bigger than this is kept in blobs of its own, so that changing it does not rewrite a page of
 * other objects, nor a page cache fill up with it.
 */
export const INLINE_BYTES = 4 * 1024;
/** How many bytes of pages are kept in memory at most, besides the index. */
export const CACHE_BYTES = 16 * 1024 * 1024;
/** How many tombstones one row of marks holds. */
export const MARKS_PER_ROW = 1000;

/** How the store lays the room out. Tests and the row counts try other sizes. */
export interface Layout {
  pageBytes: number;
  inlineBytes: number;
  cacheBytes: number;
  marksPerRow: number;
}

const LAYOUT: Layout = {
  pageBytes: PAGE_BYTES,
  inlineBytes: INLINE_BYTES,
  cacheBytes: CACHE_BYTES,
  marksPerRow: MARKS_PER_ROW,
};

/**
 * The room's tables. Made when the room is made, and wiped out whole by deleteAll when it is deleted.
 * - pages: the index of each object in entries (each StoredRecord in JSON, one to a line: the runtime
 *   reads JSON far faster than MessagePack, and a line can be written again as it was read), and their
 *   contents laid end to end in data
 * - blobs: the contents of the objects bigger than INLINE_BYTES, CHUNK_BYTES to a row
 * - marks: the tombstones, oldest first, MARKS_PER_ROW to a row (string[] in JSON)
 */
export const migrate = (sql: SqlStorage): void => {
  sql.exec('CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, entries TEXT NOT NULL, data BLOB NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS marks (id INTEGER PRIMARY KEY, entries TEXT NOT NULL)');
};

/** An object's index, as in its page but for where its contents are. */
type Index = [
  identifier: string,
  alias: string,
  major: number,
  minor: number,
  owner: string | null,
  parent: string,
  /** The view hint as JSON. */
  view: string | null,
];

/** An object's index in its page, with the bytes of its contents in the page's data (0 when in blobs) and its blobs. */
type StoredRecord = [...Index, length: number, blobs: number[] | null];

/** An object in a page. */
interface Slot {
  record: StoredRecord;
  /** Its contents, empty when in blobs. */
  bytes: Uint8Array;
  /** About how many bytes it takes in the page. */
  size: number;
  /** The record in JSON, once made. */
  json?: string;
}

/** A page's objects in their order. */
type Page = Map<string, Slot>;

interface Placed {
  page: number;
  record: StoredRecord;
}

/** The changes one flush makes, laid over what is written, and written in one transaction. */
interface Draft {
  /** The pages that change, whole, and their sizes. Empty ones are deleted. */
  pages: Map<number, Page>;
  sizes: Map<number, number>;
  /** Where each changed object now is. Null for one deleted. */
  placed: Map<string, Placed | null>;
  tail: number;
  blobs: Map<number, ArrayBuffer>;
  droppedBlobs: Set<number>;
  /** The next blob's id. 0 until the first blob is written. */
  nextBlob: number;
  /** The rows of marks that change, whole. Empty ones are deleted. */
  marks: Map<number, string[]>;
  markOf: Map<string, number | null>;
  markTail: number;
}

/** Keeps a room's objects in the SQLite of a Durable Object, packed into pages. */
export class RoomStore extends ObjectIndex {
  private readonly layout: Layout;
  /** Where each object written is, and its index as written. */
  private readonly placed = new Map<string, Placed>();
  /** About how many bytes each page holds. */
  private readonly sizes = new Map<number, number>();
  /** The last page. New objects go in it while it has room. */
  private tail = 0;
  /** Pages read lately, the most recent last, and the bytes they hold in all. */
  private readonly cache = new Map<number, Page>();
  private cached = 0;
  private nextBlob = 0;
  /** The tombstones by row of marks, oldest row first, and the row each is in. */
  private readonly markRows = new Map<number, string[]>();
  private readonly markOf = new Map<string, number>();
  private markTail = 0;

  constructor(
    private readonly storage: DurableObjectStorage,
    tombstoneLimits?: TombstoneLimits,
    layout: Partial<Layout> = {}
  ) {
    super(tombstoneLimits);
    this.layout = { ...LAYOUT, ...layout };
  }

  protected loadEntries(): [string, StoredEntry][] {
    const loaded: [string, StoredEntry][] = [];
    for (const row of this.storage.sql.exec<{ id: number; entries: string }>(
      'SELECT id, entries FROM pages ORDER BY id'
    )) {
      let size = 0;
      for (const record of recordsOf(row.entries)) {
        this.placed.set(record[0], { page: row.id, record });
        size += sizeOf(record);
        loaded.push([record[0], entryOf(record)]);
      }
      this.sizes.set(row.id, size);
      this.tail = row.id;
    }
    return loaded;
  }

  protected loadTombstones(): string[] {
    const all: string[] = [];
    for (const row of this.storage.sql.exec<{ id: number; entries: string }>(
      'SELECT id, entries FROM marks ORDER BY id'
    )) {
      const identifiers = JSON.parse(row.entries) as string[];
      this.markRows.set(row.id, identifiers);
      for (const identifier of identifiers) this.markOf.set(identifier, row.id);
      this.markTail = row.id;
      all.push(...identifiers);
    }
    return all;
  }

  protected readData(identifier: string): unknown {
    const { page, record } = this.placed.get(identifier) as Placed;
    const blobs = record[8];
    if (blobs === null) return decodeData((this.pageOf(page).get(identifier) as Slot).bytes);
    const sql = this.storage.sql;
    return decodeData(
      concat(
        blobs.map(
          (id) => new Uint8Array(sql.exec<{ data: ArrayBuffer }>('SELECT data FROM blobs WHERE id = ?', id).one().data)
        )
      )
    );
  }

  /**
   * Writes the gathered changes in one transaction. Returns how many rows SQLite wrote: the pages,
   * blobs and rows of marks that changed. Rows written are what runs out first on the free plan, so it
   * counts rows, to compare with the estimate.
   *
   * When something cannot be written, the whole transaction rolls back and nothing in memory changes.
   * Then it writes the objects again one at a time, drops only those that cannot be written, and sets
   * their index back to what is written. Without dropping them, every later flush stops at the same
   * place and nothing is kept.
   *
   * Something is pending only once the index or the tombstones have been read, so what is written has
   * been read by then too.
   */
  flush(): number {
    let rows = 0;
    const writes = [...this.pending];
    if (writes.length > 0) {
      try {
        rows = this.commit(writes);
      } catch {
        for (const write of writes) {
          try {
            rows += this.commit([write]);
          } catch (err) {
            const [identifier] = write;
            console.error('Could not keep an object:', identifier, err);
            const placed = this.placed.get(identifier);
            this.resync(identifier, placed ? entryOf(placed.record) : null, this.markOf.has(identifier));
          }
        }
      }
    }
    this.pending.clear();
    this.pruneTombstones();
    return rows;
  }

  /** Works out the changes, writes them in one transaction, and only then takes them as written. */
  private commit(writes: [string, PendingWrite][]): number {
    const draft = this.draft();
    for (const [identifier, write] of writes) {
      if (write.context !== undefined) this.place(draft, identifier, write.context, write.owner ?? null);
      if (write.tombstone !== undefined) this.mark(draft, identifier, write.tombstone);
    }
    const rows = this.storage.transactionSync(() => this.write(draft));
    this.take(draft);
    return rows;
  }

  private draft(): Draft {
    return {
      pages: new Map(),
      sizes: new Map(),
      placed: new Map(),
      tail: this.tail,
      blobs: new Map(),
      droppedBlobs: new Set(),
      nextBlob: this.nextBlob,
      marks: new Map(),
      markOf: new Map(),
      markTail: this.markTail,
    };
  }

  /** Puts an object in the draft, or takes it out (null). */
  private place(draft: Draft, identifier: string, context: ObjectContext | null, owner: string | null): void {
    // An object is written at most once in a draft, so where it was is what is written.
    const before = this.placed.get(identifier);
    const oldBlobs = before?.record[8] ?? [];
    let slot: Slot | null = null;
    if (context) {
      const { parent, view } = describe(context);
      const index: Index = [
        identifier,
        context.aliasName,
        context.majorVersion,
        context.minorVersion,
        owner,
        parent,
        view === null ? null : JSON.stringify(view),
      ];
      slot = this.slotOf(draft, index, new Uint8Array(encodeData(context.syncData)), oldBlobs);
    }
    for (const id of oldBlobs.slice(slot?.record[8]?.length ?? 0)) {
      draft.blobs.delete(id);
      draft.droppedBlobs.add(id);
    }
    this.position(draft, identifier, before ?? null, slot);
  }

  /**
   * An object's slot. Contents bigger than INLINE_BYTES go to blobs, CHUNK_BYTES to a row, taking over
   * the blobs it had first.
   */
  private slotOf(draft: Draft, index: Index, data: Uint8Array, oldBlobs: number[]): Slot {
    if (data.byteLength <= this.layout.inlineBytes) return slotOf([...index, data.byteLength, null], data);
    const blobs: number[] = [];
    for (let start = 0; start < data.byteLength; start += CHUNK_BYTES) {
      let id = oldBlobs[blobs.length];
      if (id === undefined) {
        if (draft.nextBlob === 0) draft.nextBlob = this.lastBlob() + 1;
        id = draft.nextBlob++;
      }
      blobs.push(id);
      draft.blobs.set(id, data.slice(start, start + CHUNK_BYTES).buffer);
    }
    return slotOf([...index, 0, blobs], new Uint8Array(0));
  }

  /** Sets a slot where the object was when it still fits there, otherwise in the last page. */
  private position(draft: Draft, identifier: string, before: Placed | null, slot: Slot | null): void {
    if (before) {
      const page = this.draftPage(draft, before.page);
      const old = page.get(identifier) as Slot;
      const size = (draft.sizes.get(before.page) as number) - old.size;
      if (slot && size + slot.size <= this.layout.pageBytes) {
        // Set in place, so that it keeps its order in the page.
        page.set(identifier, slot);
        draft.sizes.set(before.page, size + slot.size);
        draft.placed.set(identifier, { page: before.page, record: slot.record });
        return;
      }
      page.delete(identifier);
      draft.sizes.set(before.page, size);
    }
    if (!slot) {
      draft.placed.set(identifier, null);
      return;
    }
    // The last page is copied into the draft only when the object goes in it: a page copied is written.
    const last = draft.sizes.get(draft.tail) ?? this.sizes.get(draft.tail);
    let page: Page;
    if (last === undefined || (last > 0 && last + slot.size > this.layout.pageBytes)) {
      draft.tail += 1;
      page = new Map();
      draft.pages.set(draft.tail, page);
      draft.sizes.set(draft.tail, 0);
    } else {
      page = this.draftPage(draft, draft.tail);
    }
    page.set(identifier, slot);
    draft.sizes.set(draft.tail, (draft.sizes.get(draft.tail) as number) + slot.size);
    draft.placed.set(identifier, { page: draft.tail, record: slot.record });
  }

  /** A page in the draft, copied from what is written the first time it is touched. */
  private draftPage(draft: Draft, id: number): Page {
    let page = draft.pages.get(id);
    if (!page) {
      page = new Map(this.pageOf(id));
      draft.pages.set(id, page);
      draft.sizes.set(id, this.sizes.get(id) as number);
    }
    return page;
  }

  /** Puts a tombstone in the draft, at the end as the newest, or takes it out. */
  private mark(draft: Draft, identifier: string, marked: boolean): void {
    const row = this.markOf.get(identifier);
    if (row !== undefined) {
      const marks = this.draftMarks(draft, row);
      marks.splice(marks.indexOf(identifier), 1);
    }
    if (!marked) {
      draft.markOf.set(identifier, null);
      return;
    }
    // As with pages, the last row is copied into the draft only when the tombstone goes in it.
    const last = draft.marks.get(draft.markTail) ?? this.markRows.get(draft.markTail);
    let marks: string[];
    if (last === undefined || last.length >= this.layout.marksPerRow) {
      draft.markTail += 1;
      marks = [];
      draft.marks.set(draft.markTail, marks);
    } else {
      marks = this.draftMarks(draft, draft.markTail);
    }
    marks.push(identifier);
    draft.markOf.set(identifier, draft.markTail);
  }

  private draftMarks(draft: Draft, id: number): string[] {
    let marks = draft.marks.get(id);
    if (!marks) {
      marks = [...(this.markRows.get(id) as string[])];
      draft.marks.set(id, marks);
    }
    return marks;
  }

  /** Writes the draft. Returns how many rows it wrote. */
  private write(draft: Draft): number {
    let rows = 0;
    for (const [id, page] of draft.pages) rows += this.writePage(id, page);
    for (const [id, data] of draft.blobs) {
      rows += this.run(
        'INSERT INTO blobs (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data',
        id,
        data
      );
    }
    for (const id of draft.droppedBlobs) rows += this.run('DELETE FROM blobs WHERE id = ?', id);
    for (const [id, marks] of draft.marks) {
      rows +=
        marks.length === 0
          ? this.run('DELETE FROM marks WHERE id = ?', id)
          : this.run(
              'INSERT INTO marks (id, entries) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET entries = excluded.entries',
              id,
              JSON.stringify(marks)
            );
    }
    return rows;
  }

  /** Writes one page whole, or deletes it when nothing is left in it. Returns how many rows it wrote. */
  private writePage(id: number, page: Page): number {
    if (page.size === 0) return this.run('DELETE FROM pages WHERE id = ?', id);
    const slots = [...page.values()];
    const data = concat(slots.map((slot) => slot.bytes));
    // A record is made into JSON only when it changed: one read keeps the line it was read from.
    const entries = slots.map((slot) => (slot.json ??= JSON.stringify(slot.record))).join('\n');
    return this.run(
      `INSERT INTO pages (id, entries, data) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET entries = excluded.entries, data = excluded.data`,
      id,
      entries,
      data.buffer
    );
  }

  /** Takes what the draft wrote as what is written. */
  private take(draft: Draft): void {
    for (const [identifier, placed] of draft.placed) {
      if (placed) this.placed.set(identifier, placed);
      else this.placed.delete(identifier);
    }
    for (const [id, page] of draft.pages) {
      this.forgetPage(id);
      if (page.size === 0) {
        this.sizes.delete(id);
        continue;
      }
      this.sizes.set(id, draft.sizes.get(id) as number);
      this.keepPage(id, page);
    }
    this.tail = draft.tail;
    this.nextBlob = draft.nextBlob;
    for (const [id, marks] of draft.marks) {
      if (marks.length === 0) this.markRows.delete(id);
      else this.markRows.set(id, marks);
    }
    for (const [identifier, row] of draft.markOf) {
      if (row === null) this.markOf.delete(identifier);
      else this.markOf.set(identifier, row);
    }
    this.markTail = draft.markTail;
  }

  /** A page as written: from memory when it was read lately, otherwise read now (one row). */
  private pageOf(id: number): Page {
    const kept = this.cache.get(id);
    if (kept) {
      // The most recently used goes last.
      this.cache.delete(id);
      this.cache.set(id, kept);
      return kept;
    }
    const row = this.storage.sql
      .exec<{ entries: string; data: ArrayBuffer }>('SELECT entries, data FROM pages WHERE id = ?', id)
      .one();
    const data = new Uint8Array(row.data);
    const lines = row.entries.split('\n');
    const page: Page = new Map();
    let offset = 0;
    recordsOf(row.entries).forEach((record, line) => {
      page.set(record[0], { ...slotOf(record, data.subarray(offset, offset + record[7])), json: lines[line] });
      offset += record[7];
    });
    this.keepPage(id, page);
    return page;
  }

  /** Keeps a page in memory, letting go of the least recently used while over CACHE_BYTES. */
  private keepPage(id: number, page: Page): void {
    this.cache.set(id, page);
    this.cached += this.sizes.get(id) as number;
    for (const [oldest] of this.cache) {
      if (this.cached <= this.layout.cacheBytes || oldest === id) break;
      this.forgetPage(oldest);
    }
  }

  private forgetPage(id: number): void {
    if (!this.cache.delete(id)) return;
    this.cached -= this.sizes.get(id) as number;
  }

  private lastBlob(): number {
    return this.storage.sql.exec<{ id: number | null }>('SELECT MAX(id) AS id FROM blobs').one().id ?? 0;
  }

  /** Runs a writing statement through to the end and returns how many rows it wrote. */
  private run(query: string, ...bindings: SqlStorageValue[]): number {
    const cursor = this.storage.sql.exec(query, ...bindings);
    cursor.toArray();
    return cursor.rowsWritten;
  }

  /** When there are too many tombstones, removes the oldest first: whole rows, and part of the last. */
  private pruneTombstones(): void {
    let over = this.tombstonesOver();
    if (over === 0) return;
    const draft = this.draft();
    for (const [id, marks] of this.markRows) {
      const gone = marks.slice(0, over);
      draft.marks.set(id, marks.slice(gone.length));
      for (const identifier of gone) {
        draft.markOf.set(identifier, null);
        (this.tombstones as Set<string>).delete(identifier);
      }
      over -= gone.length;
      if (over === 0) break;
    }
    this.storage.transactionSync(() => this.write(draft));
    this.take(draft);
  }
}

const entryOf = (record: StoredRecord): StoredEntry => ({
  alias: record[1],
  majorVersion: record[2],
  minorVersion: record[3],
  owner: record[4],
  parent: record[5],
  view: record[6] === null ? null : (JSON.parse(record[6]) as View),
});

/** About how many bytes an object takes in its page: its contents, and its index in JSON. */
const sizeOf = (record: StoredRecord): number =>
  record[7] +
  32 +
  record[0].length +
  record[1].length +
  (record[4]?.length ?? 0) +
  record[5].length +
  (record[6]?.length ?? 0) +
  (record[8]?.length ?? 0) * 9;

/** The records of a page's entries, one JSON to a line, read in one go. */
const recordsOf = (entries: string): StoredRecord[] =>
  JSON.parse(`[${entries.replaceAll('\n', ',')}]`) as StoredRecord[];

const slotOf = (record: StoredRecord, bytes: Uint8Array): Slot => ({ record, bytes, size: sizeOf(record) });

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

/**
 * The store of a room: pages, or the rows of a room made before pages (see LegacyRoomStore). A room is
 * made with the tables of one or the other, so the tables tell which.
 */
export const openStore = (storage: DurableObjectStorage): StoreOfRoom =>
  storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'objects'").toArray().length > 0
    ? new LegacyRoomStore(storage)
    : new RoomStore(storage);
