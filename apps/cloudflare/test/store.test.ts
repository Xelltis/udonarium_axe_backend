import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { RoomStore, migrate } from '../src/rooms/store';
import { contextOf } from './room-helpers';

/** 空の Durable Object の置き場所で、部屋の置き場所を試す */
const withStore = <T>(name: string, run: (store: RoomStore, storage: DurableObjectStorage) => T) =>
  runInDurableObject(env.ROOMS.getByName(name), (_instance, state) => {
    migrate(state.storage.sql);
    return run(new RoomStore(state.storage), state.storage);
  });

describe('the room store', () => {
  it('reads back what decides visibility from SQLite', async () => {
    const view = await withStore('store-reload', (store, storage) => {
      store.put(contextOf('card', 1, 0.5, { attributes: { state: 1 } }, 'card'), null);
      store.flush();
      return new RoomStore(storage).lookup('card');
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

  it('follows children and reactions, and does not loop on parents that point at each other', async () => {
    const found = await withStore('store-relations', (store) => {
      store.put(contextOf('a', 1, 0.5, { parentIdentifier: 'b' }), null);
      store.put(contextOf('b', 1, 0.5, { parentIdentifier: 'a' }), null);
      store.put(contextOf('m', 1, 0.5, {}, 'chat'), null);
      store.put(contextOf('r', 1, 0.5, { messageIdentifier: 'm' }, 'chat-reaction'), null);
      const before = [store.dependentsOf('a'), store.dependentsOf('m'), store.descendantsOf('m')];
      // 付け替えと消したものは、引きからも外れる
      store.put(contextOf('r', 2, 0.5, { messageIdentifier: 'other' }, 'chat-reaction'), null);
      store.delete('b', false);
      return [...before, store.dependentsOf('m'), store.dependentsOf('a')];
    });
    expect(found).toEqual([['b'], ['r'], [], [], []]);
  });
});
