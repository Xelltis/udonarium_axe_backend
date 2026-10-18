import { encode } from '@msgpack/msgpack';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeData } from '../../../src/core/rooms/codec.js';

import { MAX_BATCH_BYTES, batchesOf, fencedWrite } from '../../../src/server/rooms/fence.js';
import type { Op } from '../../../src/server/rooms/fence.js';
import { CHUNK_BYTES, RedisRoomStore, storeKeysOf } from '../../../src/server/rooms/store.js';
import { binaryOf } from '../../../src/server/redis.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

const LEASE = 'instance:1';

const contextOf = (
  identifier: string,
  majorVersion = 1,
  syncData: Record<string, unknown> = { value: identifier },
  aliasName = 'character'
) => ({ aliasName, identifier, majorVersion, minorVersion: 0.5, syncData });

/** Makes a store that took the lease, as the room's owner. */
const room = async (limits?: { most: number; prunedTo: number }) => {
  const key = freshKey();
  const keys = storeKeysOf(key, 'room');
  const leaseKey = key('r', 'room', 'lease');
  const fence = { lease: leaseKey, meta: key('r', 'room', 'meta') };
  await connection.redis.set(leaseKey, LEASE);
  await connection.redis.hSet(fence.meta, 'roomKey', 'room');
  let cut = false;
  const persist = async (ops: Op[]) => {
    if (cut) {
      cut = false;
      await fencedWrite(connection.redis, fence, LEASE, batchesOf(ops)[0]);
      throw new Error('cut short');
    }
    if (!(await fencedWrite(connection.redis, fence, LEASE, ops))) throw new Error('fenced');
  };
  const open = () => RedisRoomStore.load(binaryOf(connection.redis), keys, persist, limits);
  /** Makes the next write stop after its first batch. */
  const cutShort = () => {
    cut = true;
  };
  return { open, store: await open(), leaseKey, keys, cutShort };
};

describe('a room store in Redis', () => {
  it('keeps what is put, and gives it back to the next owner', async () => {
    const { open, store } = await room();
    store.put(contextOf('piece', 2, { value: 'p', parentIdentifier: 'table' }), null);
    store.put(contextOf('cursor-a', 1, { peerId: 'a' }, 'PeerCursor'), 'a');

    store.flush();
    await store.settle();
    const again = await open();

    expect(again.get('piece')).toEqual(contextOf('piece', 2, { value: 'p', parentIdentifier: 'table' }));
    expect(again.entryOf('piece')).toMatchObject({ parent: 'table', majorVersion: 2 });
    expect(again.ownedBy('a')).toEqual(['cursor-a']);
    expect(again.catalog()).toHaveLength(2);
  });

  it('answers from what it holds while the writing is still on its way', async () => {
    const { store } = await room();
    store.put(contextOf('piece', 1), null);
    store.flush();

    expect(store.get('piece')?.syncData).toEqual({ value: 'piece' });
    await store.settle();
  });

  it('splits an object larger than a value takes, and rewrites it whole', async () => {
    const { open, store, keys } = await room();
    const big = { scene: 'x'.repeat(2 * CHUNK_BYTES + 10) };
    store.put(contextOf('scene', 1, big), null);
    store.flush();
    await store.settle();
    const [parts] = await connection.redis.sMembers(keys.chunked);
    expect(parts).toMatch(/^scene#/);
    expect(await connection.redis.hLen(keys.chunks(parts))).toBe(3);

    store.put(contextOf('scene', 2, { scene: 'small' }), null);
    store.flush();
    await store.settle();

    expect(await connection.redis.exists(keys.chunks(parts))).toBe(0);
    expect(await connection.redis.sMembers(keys.chunked)).toEqual([]);
    expect((await open()).get('scene')?.syncData).toEqual({ scene: 'small' });

    store.put(contextOf('scene', 3, big), null);
    store.flush();
    await store.settle();
    expect((await open()).get('scene')?.syncData).toEqual(big);
  });

  it('keeps the older version whole when a write of a split-up object stops partway', async () => {
    const { open, store, keys, cutShort } = await room();
    const older = { scene: 'x'.repeat(5 * CHUNK_BYTES) };
    store.put(contextOf('scene', 1, older), null);
    store.flush();
    await store.settle();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cutShort();

    store.put(contextOf('scene', 2, { scene: 'y'.repeat(5 * CHUNK_BYTES) }), null);
    store.flush();
    await store.settle();

    expect((await open()).get('scene')).toEqual(contextOf('scene', 1, older));
    expect(await connection.redis.sCard(keys.chunked)).toBe(2);
  });

  it('leaves out an object whose parts are missing, opens the rest, and takes it away with the next write', async () => {
    const { open, store, keys } = await room();
    store.put(contextOf('scene', 1, { scene: 'x'.repeat(2 * CHUNK_BYTES + 10) }), null);
    store.put(contextOf('piece', 1), null);
    store.flush();
    await store.settle();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [parts] = await connection.redis.sMembers(keys.chunked);
    await connection.redis.hDel(keys.chunks(parts), '1');

    const again = await open();
    again.flush();
    await again.settle();

    expect(again.get('scene')).toBeNull();
    expect(again.get('piece')?.syncData).toEqual({ value: 'piece' });
    expect(error).toHaveBeenCalledWith('An object’s parts are missing; it is left out:', 'scene');
    expect(await connection.redis.hExists(keys.objects, 'scene')).toBe(0);
    expect(await connection.redis.exists(keys.chunks(parts))).toBe(0);
    expect(await connection.redis.sMembers(keys.chunked)).toEqual([]);
  });

  it('reads a split-up object kept under its own name, and moves it to a new name when written again', async () => {
    const { open, keys } = await room();
    const data = Buffer.from(encodeData({ scene: 'x'.repeat(CHUNK_BYTES + 10) }));
    const stored = { alias: 'character', major: 1, minor: 0.5, owner: null, parent: '', view: null, chunks: 2 };
    await connection.redis.hSet(keys.objects, 'scene', Buffer.from(encode(stored)));
    await connection.redis.hSet(keys.chunks('scene'), {
      0: data.subarray(0, CHUNK_BYTES),
      1: data.subarray(CHUNK_BYTES),
    });
    await connection.redis.sAdd(keys.chunked, 'scene');

    const store = await open();
    expect(store.get('scene')?.syncData).toEqual({ scene: 'x'.repeat(CHUNK_BYTES + 10) });
    store.put(contextOf('scene', 2, { scene: 'y'.repeat(CHUNK_BYTES + 10) }), null);
    store.flush();
    await store.settle();

    expect(await connection.redis.exists(keys.chunks('scene'))).toBe(0);
    expect(await connection.redis.sMembers(keys.chunked)).toEqual([expect.stringMatching(/^scene#/)]);
    expect((await open()).get('scene')?.syncData).toEqual({ scene: 'y'.repeat(CHUNK_BYTES + 10) });
  });

  it('keeps the mark of what was deleted, and drops it when told to forget', async () => {
    const { open, store, keys } = await room();
    store.put(contextOf('gone'), null);
    store.put(contextOf('cursor-b', 1, { peerId: 'b' }, 'PeerCursor'), 'b');
    store.flush();
    store.delete('gone', true);
    store.delete('cursor-b', false);
    store.flush();
    await store.settle();

    const after = await open();
    expect(after.isDeleted('gone')).toBe(true);
    expect(after.get('gone')).toBeNull();
    expect(after.isDeleted('cursor-b')).toBe(false);
    expect(await connection.redis.hLen(keys.objects)).toBe(0);

    after.forget(['gone']);
    after.flush();
    await after.settle();
    expect((await open()).isDeleted('gone')).toBe(false);
  });

  it('keeps no more marks than its limit, dropping the oldest', async () => {
    const { open, store } = await room({ most: 3, prunedTo: 2 });
    const now = vi.spyOn(Date, 'now');
    for (const [i, identifier] of ['a', 'b', 'c', 'd'].entries()) {
      now.mockReturnValue(1000 + i);
      store.put(contextOf(identifier), null);
      store.delete(identifier, true);
      store.flush();
    }
    await store.settle();

    const after = await open();
    expect(['a', 'b', 'c', 'd'].filter((id) => after.isDeleted(id))).toEqual(['c', 'd']);
    expect(['a', 'b', 'c', 'd'].filter((id) => store.isDeleted(id))).toEqual(['c', 'd']);
  });

  it('goes on writing after a write that failed, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { open, store, leaseKey } = await room();
    await connection.redis.set(leaseKey, 'someone-else');
    store.put(contextOf('lost'), null);
    store.flush();
    await store.settle();
    await connection.redis.set(leaseKey, LEASE);
    store.put(contextOf('kept'), null);
    store.flush();
    await store.settle();

    const after = await open();
    expect(error).toHaveBeenCalledWith('Could not keep the room’s objects:', expect.any(Error));
    expect(after.get('lost')).toBeNull();
    expect(after.get('kept')).not.toBeNull();
    expect(store.flush()).toBe(0);
  });
});

describe('fenced writes', () => {
  it('writes nothing for an owner whose lease has passed to another, or into a room going away', async () => {
    const key = freshKey();
    const fence = { lease: key('lease'), meta: key('meta') };
    const write = () =>
      fencedWrite(connection.redis, fence, LEASE, [{ command: 'SET', key: key('value'), args: ['1'] }]);
    await connection.redis.set(fence.lease, 'other');
    const someoneElse = await write();
    await connection.redis.set(fence.lease, LEASE);
    const noRoom = await write();
    await connection.redis.hSet(fence.meta, 'deleting', '1');
    const deleting = await write();
    await connection.redis.hDel(fence.meta, 'deleting');
    await connection.redis.hSet(fence.meta, 'roomKey', 'room');
    const written = await write();

    expect([someoneElse, noRoom, deleting, written]).toEqual([false, false, false, true]);
    expect(await connection.redis.get(key('value'))).toBe('1');
  });

  it('sends a large batch in parts small enough for one request', () => {
    const half = Buffer.alloc(MAX_BATCH_BYTES / 2);
    const op = (key: string): Op => ({ command: 'HSET', key, args: ['f', half] });

    expect(batchesOf([op('a'), op('b'), op('c')]).map((batch) => batch.length)).toEqual([1, 1, 1]);
    expect(batchesOf([])).toEqual([]);
    expect(
      batchesOf([
        { command: 'DEL', key: 'a', args: [] },
        { command: 'DEL', key: 'b', args: [] },
      ])
    ).toHaveLength(1);
  });
});
