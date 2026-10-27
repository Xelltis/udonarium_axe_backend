import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { LegacyRoomStore } from '../src/rooms/legacy-store';
import { writeLegacyRoom } from './rows/legacy';
import { contextOf } from './shared/room-helpers';

/** Tries out the store of a room made before pages, on the storage of an empty Durable Object. */
const withStore = <T>(name: string, run: (store: LegacyRoomStore, storage: DurableObjectStorage) => T) =>
  runInDurableObject(env.ROOMS.getByName(name), (_instance, state) => {
    writeLegacyRoom(state.storage.sql, []);
    return run(new LegacyRoomStore(state.storage), state.storage);
  });

describe('the store of a room made before pages', () => {
  it('reads back what decides visibility from SQLite', async () => {
    const view = await withStore('legacy-reload', (store, storage) => {
      store.put(contextOf('card', 1, 0.5, { attributes: { state: 1 } }, 'card'), null);
      store.flush();
      return new LegacyRoomStore(storage).lookup('card');
    });
    expect(view).toEqual({
      alias: 'card',
      majorVersion: 1,
      minorVersion: 0.5,
      owner: null,
      parent: '',
      view: { kind: 'card', front: false, owner: '', hand: '' },
    });
  });

  it('writes two rows to put an object there, and one to change it', async () => {
    const rows = await withStore('legacy-rows', (store) => {
      store.put(contextOf('piece', 1, 0.5), null);
      const put = store.flush();
      store.put(contextOf('piece', 2, 0.5), null);
      return [put, store.flush()];
    });

    // The row, and the row of its primary key's index; then the row alone, changed in place.
    expect(rows).toEqual([2, 1]);
  });

  it('follows children and reactions, and does not loop on parents that point at each other', async () => {
    const found = await withStore('legacy-relations', (store) => {
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

  it('keeps what it can when one object cannot be written, rather than stopping', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const kept = await withStore('legacy-bad-write', (store, storage) => {
      const write = (store as unknown as { writeObject: (context: unknown) => void }).writeObject;
      vi.spyOn(
        store as unknown as { writeObject: (context: { identifier: string }) => void },
        'writeObject'
      ).mockImplementation(function (this: unknown, context: { identifier: string }) {
        if (context.identifier === 'bad') throw new Error('row too big');
        return write.call(this, context);
      });
      store.put(contextOf('good', 1, 0.5), null);
      store.put(contextOf('bad', 1, 0.5), null);
      store.flush();
      return storage.sql
        .exec<{ identifier: string }>('SELECT identifier FROM objects')
        .toArray()
        .map((row) => row.identifier);
    });
    expect(kept).toEqual(['good']);
    expect(error).toHaveBeenCalled();
  });

  it('goes back to what is written for an object it could not write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = await withStore('legacy-resync', (store) => {
      store.put(contextOf('kept', 1, 0.5, { value: 'first' }), null);
      store.delete('marked', true);
      store.flush();
      const write = (store as unknown as { writeObject: (context: unknown) => number }).writeObject;
      vi.spyOn(
        store as unknown as { writeObject: (context: { identifier: string }) => number },
        'writeObject'
      ).mockImplementation(function (this: unknown, context: { identifier: string }) {
        if (context.identifier !== 'other') throw new Error('row too big');
        return write.call(this, context);
      });
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
        other: store.entryOf('other')?.majorVersion,
      };
    });
    expect(after).toEqual({ kept: [1, 'first'], added: null, marked: true, other: 1 });
  });

  it('splits a large object over chunks, rewrites it in place and deletes the chunks with it', async () => {
    const counts = await withStore('legacy-chunks', (store, storage) => {
      const chunks = () => storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM object_chunks').one().n;
      const big = { scene: 'x'.repeat(2 * 1024 * 1024 + 10) };
      store.put(contextOf('board', 1, 0.5, big), null);
      store.flush();
      const first = chunks();
      const read = new LegacyRoomStore(storage).get('board')?.syncData;
      store.put(contextOf('board', 2, 0.5, { scene: '' }), null);
      store.flush();
      const second = chunks();
      store.delete('board', true);
      store.put(contextOf('cursor', 1, 0.5, {}, 'PeerCursor'), 'peer');
      store.flush();
      const deleted = new LegacyRoomStore(storage).isDeleted('board');
      store.forget(['board']);
      store.flush();
      const reopened = new LegacyRoomStore(storage);
      return {
        first,
        read: read?.scene === big.scene,
        second,
        deleted,
        forgotten: reopened.isDeleted('board'),
        owner: reopened.entryOf('cursor')?.owner,
      };
    });

    expect(counts).toEqual({ first: 3, read: true, second: 0, deleted: true, forgotten: false, owner: 'peer' });
  });

  it('forgets the oldest marks of what was deleted once there are too many', async () => {
    const left = await runInDurableObject(env.ROOMS.getByName('legacy-prune'), (_instance, state) => {
      writeLegacyRoom(state.storage.sql, []);
      const store = new LegacyRoomStore(state.storage, { most: 3, prunedTo: 2 });
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
      for (const identifier of ['a', 'b', 'c', 'd']) {
        store.delete(identifier, true);
        store.flush();
      }
      return ['a', 'b', 'c', 'd'].filter((identifier) => store.isDeleted(identifier));
    });
    expect(left).toEqual(['c', 'd']);
  });
});
