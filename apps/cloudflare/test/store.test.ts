import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TombstoneLimits } from '../src/core/rooms/object-index';
import { CHUNK_BYTES, RoomStore, migrate } from '../src/rooms/store';
import type { Layout } from '../src/rooms/store';
import { contextOf } from './shared/room-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Tries out the room's store on the storage of an empty Durable Object. open makes a store over that
 * storage, as a room that woke up does.
 */
const withStore = <T>(
  name: string,
  run: (open: (layout?: Partial<Layout>, limits?: TombstoneLimits) => RoomStore, sql: SqlStorage) => T
) =>
  runInDurableObject(env.ROOMS.getByName(name), (_instance, state) => {
    migrate(state.storage.sql);
    return run((layout = {}, limits) => new RoomStore(state.storage, limits, layout), state.storage.sql);
  });

const count = (sql: SqlStorage, table: string) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

/** Counts the rows SQLite reads while run runs. */
const rowsRead = (sql: SqlStorage, run: () => void) => {
  const exec = sql.exec.bind(sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query, ...bindings) => {
    const cursor = exec(query, ...bindings);
    cursors.push(cursor);
    return cursor;
  });
  run();
  spy.mockRestore();
  return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
};

/** Makes the store's page writes fail for the pages holding any object test picks. */
const failPagesWith = (store: RoomStore, test: (identifier: string) => boolean) => {
  const writePage = (store as unknown as { writePage: (id: number, page: Map<string, unknown>) => number }).writePage;
  vi.spyOn(
    store as unknown as { writePage: (id: number, page: Map<string, unknown>) => number },
    'writePage'
  ).mockImplementation(function (this: unknown, id: number, page: Map<string, unknown>) {
    if ([...page.keys()].some(test)) throw new Error('cannot write');
    return writePage.call(this, id, page);
  });
};

describe('the room store', () => {
  it('reads back what decides visibility', async () => {
    const view = await withStore('store-reload', (open) => {
      const store = open();
      store.put(contextOf('card', 1, 0.5, { attributes: { state: 1 } }, 'card'), null);
      store.put(contextOf('cursor', 1, 0.5, {}, 'PeerCursor'), 'peer');
      store.flush();
      const reopened = open();
      return [reopened.lookup('card'), reopened.lookup('cursor')?.owner];
    });

    expect(view).toEqual([
      {
        alias: 'card',
        majorVersion: 1,
        minorVersion: 0.5,
        owner: null,
        parent: '',
        view: { kind: 'card', front: false, owner: '', hand: '' },
      },
      'peer',
    ]);
  });

  it('follows children and reactions, and does not loop on parents that point at each other', async () => {
    const found = await withStore('store-relations', (open) => {
      const store = open();
      store.put(contextOf('a', 1, 0.5, { parentIdentifier: 'b' }), null);
      store.put(contextOf('b', 1, 0.5, { parentIdentifier: 'a' }), null);
      store.put(contextOf('m', 1, 0.5, {}, 'chat'), null);
      store.put(contextOf('r', 1, 0.5, { messageIdentifier: 'm' }, 'chat-reaction'), null);
      const before = [store.dependentsOf('a'), store.dependentsOf('m'), store.descendantsOf('m')];
      // What was moved elsewhere and what was deleted drop out of the lookups too.
      store.put(contextOf('r', 2, 0.5, { messageIdentifier: 'other' }, 'chat-reaction'), null);
      store.delete('b', false);
      return [...before, store.dependentsOf('m'), store.dependentsOf('a')];
    });

    expect(found).toEqual([['b'], ['r'], [], [], []]);
  });

  it('puts many objects in one page, and writes one row to change one of them', async () => {
    const result = await withStore('store-one-page', (open, sql) => {
      const store = open();
      for (let i = 0; i < 20; i++) store.put(contextOf(`piece-${i}`, 1, 0.5), null);
      const put = store.flush();
      store.put(contextOf('piece-7', 2, 0.5, { value: 'moved' }), null);
      const changed = store.flush();
      const reopened = open();
      return {
        put,
        changed,
        nothing: store.flush(),
        pages: count(sql, 'pages'),
        read: [reopened.get('piece-7')?.syncData, reopened.get('piece-3')?.syncData],
      };
    });

    expect(result).toEqual({
      put: 1,
      changed: 1,
      nothing: 0,
      pages: 1,
      read: [{ value: 'moved' }, { value: 'piece-3@1' }],
    });
  });

  it('starts a new page when the last one is full, and keeps the order objects came in', async () => {
    const result = await withStore('store-pages', (open, sql) => {
      const store = open({ pageBytes: 200 });
      const identifiers = Array.from({ length: 12 }, (_, i) => `piece-${i}`);
      for (const identifier of identifiers) store.put(contextOf(identifier, 1, 0.5), null);
      store.flush();
      return {
        pages: count(sql, 'pages'),
        order: open()
          .catalog()
          .map((item) => item.identifier),
        identifiers,
      };
    });

    expect(result.pages).toBeGreaterThan(2);
    expect(result.order).toEqual(result.identifiers);
  });

  it('moves an object that no longer fits its page to the last page, and deletes a page left empty', async () => {
    const result = await withStore('store-move', (open, sql) => {
      const store = open({ pageBytes: 300 });
      store.put(contextOf('a', 1, 0.5), null);
      store.put(contextOf('b', 1, 0.5), null);
      store.flush();
      const pagesBefore = sql.exec<{ id: number }>('SELECT id FROM pages').toArray();
      store.put(contextOf('a', 2, 0.5, { value: 'x'.repeat(200) }), null);
      store.flush();
      store.delete('b', false);
      store.flush();
      const reopened = open({ pageBytes: 300 });
      return {
        pagesBefore,
        pagesAfter: sql.exec<{ id: number }>('SELECT id FROM pages').toArray(),
        a: reopened.get('a')?.syncData.value,
        b: reopened.entryOf('b'),
      };
    });

    expect(result).toEqual({ pagesBefore: [{ id: 1 }], pagesAfter: [{ id: 2 }], a: 'x'.repeat(200), b: null });
  });

  it('starts a page afresh after the last one was emptied, and fills one emptied in the same write', async () => {
    const result = await withStore('store-emptied', (open, sql) => {
      const store = open({ pageBytes: 100 });
      store.put(contextOf('a', 1, 0.5), null);
      store.flush();
      store.put(contextOf('b', 1, 0.5), null);
      store.flush();
      // b was alone in the last page, which goes; c then needs a page of its own.
      store.delete('b', false);
      store.flush();
      store.put(contextOf('c', 1, 0.5), null);
      store.flush();
      const afterC = sql.exec<{ id: number }>('SELECT id FROM pages ORDER BY id').toArray();
      // c leaves its page and d comes in the same write: d takes the page c left.
      store.delete('c', false);
      store.put(contextOf('d', 1, 0.5), null);
      store.flush();
      return {
        afterC,
        afterD: sql.exec<{ id: number }>('SELECT id FROM pages ORDER BY id').toArray(),
        all: open().identifiers(),
      };
    });

    expect(result).toEqual({
      afterC: [{ id: 1 }, { id: 3 }],
      afterD: [{ id: 1 }, { id: 3 }],
      all: ['a', 'd'],
    });
  });

  it('keeps a big object in blobs of its own, and takes over, adds and drops its blobs as it changes', async () => {
    const result = await withStore('store-blobs', (open, sql) => {
      const blobs = () =>
        sql
          .exec<{ id: number }>('SELECT id FROM blobs ORDER BY id')
          .toArray()
          .map((row) => row.id);
      const store = open({ inlineBytes: 100 });
      store.put(contextOf('note', 1, 0.5, { value: 'n'.repeat(500) }), null);
      store.put(contextOf('piece', 1, 0.5), null);
      store.flush();
      const first = blobs();
      const read = open().get('note')?.syncData.value;
      store.put(contextOf('note', 2, 0.5, { value: 'm'.repeat(600) }), null);
      const changed = store.flush();
      const second = blobs();
      store.put(contextOf('note', 3, 0.5, { value: 'x'.repeat(CHUNK_BYTES + 10) }), null);
      store.flush();
      const third = blobs();
      const big = open().get('note')?.syncData.value === 'x'.repeat(CHUNK_BYTES + 10);
      // A store that wakes up goes on after the blobs already there.
      const woken = open({ inlineBytes: 100 });
      woken.put(contextOf('board', 1, 0.5, { value: 'b'.repeat(500) }), null);
      woken.put(contextOf('scene', 1, 0.5, { value: 's'.repeat(500) }), null);
      woken.flush();
      const fourth = blobs();
      woken.put(contextOf('note', 4, 0.5, { value: 'short' }), null);
      woken.delete('board', false);
      woken.flush();
      const reopened = open();
      return {
        first,
        read: read === 'n'.repeat(500),
        changed,
        second,
        third,
        big,
        fourth,
        fifth: blobs(),
        values: [reopened.get('note')?.syncData.value, reopened.get('scene')?.syncData.value === 's'.repeat(500)],
      };
    });

    expect(result).toEqual({
      first: [1],
      read: true,
      // Its page, for the version, and its blob.
      changed: 2,
      second: [1],
      third: [1, 2],
      big: true,
      fourth: [1, 2, 3, 4],
      fifth: [4],
      values: ['short', true],
    });
  });

  it('keeps tombstones in rows, the newest last, and takes them out when forgotten', async () => {
    const result = await withStore('store-marks', (open, sql) => {
      const rows = () => sql.exec<{ entries: string }>('SELECT entries FROM marks ORDER BY id').toArray();
      const store = open({ marksPerRow: 2 });
      for (const identifier of ['a', 'b', 'c']) store.delete(identifier, true);
      store.flush();
      const first = rows();
      // Deleted again, a is the newest.
      store.delete('a', true);
      store.flush();
      const second = rows();
      store.forget(['b', 'c']);
      store.flush();
      const third = rows();
      store.forget(['a']);
      store.flush();
      store.delete('d', true);
      store.flush();
      const reopened = open();
      return {
        first,
        second,
        third,
        fourth: rows(),
        deleted: ['a', 'b', 'c', 'd'].filter((identifier) => reopened.isDeleted(identifier)),
      };
    });

    expect(result).toEqual({
      first: [{ entries: '["a","b"]' }, { entries: '["c"]' }],
      second: [{ entries: '["b"]' }, { entries: '["c","a"]' }],
      third: [{ entries: '["a"]' }],
      fourth: [{ entries: '["d"]' }],
      deleted: ['d'],
    });
  });

  it('forgets the oldest tombstones once there are too many: whole rows, and part of the next', async () => {
    const result = await withStore('store-prune', (open, sql) => {
      const store = open({ marksPerRow: 2 }, { most: 3, prunedTo: 1 });
      for (const identifier of ['a', 'b', 'c', 'd']) {
        store.delete(identifier, true);
        store.flush();
      }
      return {
        held: ['a', 'b', 'c', 'd'].filter((identifier) => store.isDeleted(identifier)),
        written: sql.exec<{ entries: string }>('SELECT entries FROM marks').toArray(),
        reopened: ['a', 'b', 'c', 'd'].filter((identifier) => open().isDeleted(identifier)),
      };
    });

    expect(result).toEqual({ held: ['d'], written: [{ entries: '["d"]' }], reopened: ['d'] });
  });

  it('reads a page once and keeps it, and reads again one let go of to stay within its memory', async () => {
    const result = await withStore('store-cache', (open, sql) => {
      const store = open({ pageBytes: 200 });
      for (let i = 0; i < 6; i++) store.put(contextOf(`piece-${i}`, 1, 0.5), null);
      store.flush();
      const roomy = open({ pageBytes: 200 });
      roomy.identifiers();
      const readTwice = (reader: RoomStore) =>
        [0, 1].map(() =>
          rowsRead(sql, () => {
            for (let i = 0; i < 6; i++) reader.get(`piece-${i}`);
          })
        );
      const tight = open({ pageBytes: 200, cacheBytes: 1 });
      tight.identifiers();
      return {
        pages: count(sql, 'pages'),
        roomy: readTwice(roomy),
        tight: readTwice(tight),
        value: tight.get('piece-5')?.syncData.value,
      };
    });

    expect(result.roomy).toEqual([result.pages, 0]);
    expect(result.tight).toEqual([result.pages, result.pages]);
    expect(result.value).toBe('piece-5@1');
  });

  it('keeps what it can when an object cannot be written, rather than stopping', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const kept = await withStore('store-bad-write', (open) => {
      const store = open();
      failPagesWith(store, (identifier) => identifier === 'bad');
      store.put(contextOf('good', 1, 0.5), null);
      store.put(contextOf('bad', 1, 0.5), null);
      store.flush();
      return [open().identifiers(), store.entryOf('bad')];
    });

    expect(kept).toEqual([['good'], null]);
    expect(error).toHaveBeenCalledWith('Could not keep an object:', 'bad', expect.any(Error));
  });

  it('goes back to what is written for an object it could not write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = await withStore('store-resync', (open) => {
      // A page for each object, so that one write does not take another with it.
      const store = open({ pageBytes: 1 });
      store.put(contextOf('kept', 1, 0.5, { value: 'first' }), null);
      store.delete('marked', true);
      store.flush();
      failPagesWith(store, (identifier) => identifier !== 'other');
      store.put(contextOf('kept', 2, 0.5, { value: 'second' }), null);
      store.put(contextOf('new', 1, 0.5), null);
      store.put(contextOf('other', 1, 0.5), null);
      store.forget(['marked']);
      store.put(contextOf('marked', 1, 0.5), null);
      store.flush();
      return {
        kept: [store.entryOf('kept')?.majorVersion, store.get('kept')?.syncData.value],
        added: store.entryOf('new'),
        marked: store.isDeleted('marked'),
        other: open().entryOf('other')?.majorVersion,
      };
    });

    expect(after).toEqual({ kept: [1, 'first'], added: null, marked: true, other: 1 });
  });
});
