import { afterEach, describe, expect, it, vi } from 'vitest';

import { redisLobby } from '../../../src/server/lobby.js';
import type { KeyOf } from '../../../src/server/redis.js';
import {
  createRoom,
  expiryKeyOf,
  readRoomMeta,
  roomKeysOf,
} from '../../../src/server/rooms/keys.js';
import { SWEEP_ROOMS, roomSweeper } from '../../../src/server/rooms/sweep.js';
import type { SweepDeps } from '../../../src/server/rooms/sweep.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

/** 部屋を作って一覧に載せ、past の部屋は消す時刻を過ぎたことにする */
const setUp = async (
  rooms: Record<string, 'past' | 'future'>,
  overrides: Partial<SweepDeps> = {},
) => {
  const key = freshKey();
  const lobby = redisLobby(connection.redis, key);
  for (const [roomKey, when] of Object.entries(rooms)) {
    const init = { roomKey, roomId: 'abc', name: roomKey, password: '' };
    await createRoom(connection.redis, key, { ...init, creatorUserId: 'user-gm', host: 'h' }, 3600);
    await lobby.register({ ...init, hasPassword: false, members: 0 });
    if (when === 'past') {
      await connection.redis.zAdd(expiryKeyOf(key), { score: Date.now() - 1, value: roomKey });
    }
  }
  const deferred: Promise<unknown>[] = [];
  const deleted: string[] = [];
  const sweeper = roomSweeper({
    redis: connection.redis,
    key,
    lobby,
    deleteAssets: async (roomKey) => {
      deleted.push(roomKey);
    },
    defer: (work) => void deferred.push(work),
    ...overrides,
  });
  return { key, lobby, sweeper, deferred, deleted };
};

const metaOf = (key: KeyOf, roomKey: string) =>
  connection.redis.exists(roomKeysOf(key, roomKey).meta);

describe('the room sweeper', () => {
  it('wipes the rooms past their time, with their assets, and leaves the rest', async () => {
    const { key, lobby, sweeper, deleted } = await setUp({ old: 'past', fresh: 'future' });

    expect(await sweeper.now()).toBe(1);

    expect(deleted).toEqual(['old']);
    expect(await metaOf(key, 'old')).toBe(0);
    expect(await lobby.find('old')).toBeNull();
    expect(await connection.redis.zScore(expiryKeyOf(key), 'old')).toBeNull();
    expect(await readRoomMeta(connection.redis, key, 'fresh')).not.toBeNull();
    expect(await lobby.find('fresh')).not.toBeNull();
  });

  it('sweeps on the side a few rooms at a time, once a while across instances', async () => {
    const rooms = Object.fromEntries(
      Array.from({ length: SWEEP_ROOMS + 2 }, (_, i) => [`room-${i}`, 'past' as const]),
    );
    const { key, sweeper, deferred } = await setUp(rooms);

    sweeper.soon();
    sweeper.soon();
    await Promise.all(deferred);

    expect(await connection.redis.zCard(expiryKeyOf(key))).toBe(2);
  });

  it('still wipes a room whose assets cannot be deleted, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { key, sweeper } = await setUp(
      { old: 'past' },
      { deleteAssets: () => Promise.reject(new Error('blob down')) },
    );

    expect(await sweeper.now()).toBe(1);

    expect(error).toHaveBeenCalledWith('Room asset deletion failed:', expect.any(Error));
    expect(await metaOf(key, 'old')).toBe(0);
  });

  it('tries a room it could not wipe again a while later, keeping it shut meanwhile', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { key, lobby, sweeper } = await setUp({ bad: 'past', good: 'past' });
    const remove = lobby.remove.bind(lobby);
    vi.spyOn(lobby, 'remove').mockImplementation((roomKey) =>
      roomKey === 'bad' ? Promise.reject(new Error('lobby down')) : remove(roomKey),
    );

    expect(await sweeper.now()).toBe(1);

    expect(error).toHaveBeenCalledWith('Room sweep failed, to be tried again:', expect.any(Error));
    expect(await metaOf(key, 'good')).toBe(0);
    expect(await connection.redis.zScore(expiryKeyOf(key), 'bad')).toBeGreaterThan(Date.now());
    expect(await readRoomMeta(connection.redis, key, 'bad')).toBeNull();
  });

  it('says so when it could not sweep on the side', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sweeper, deferred } = await setUp({});
    vi.spyOn(connection.redis, 'set').mockRejectedValueOnce(new Error('down'));

    sweeper.soon();
    await Promise.all(deferred);

    expect(error).toHaveBeenCalledWith('Room sweep failed:', expect.any(Error));
  });
});
