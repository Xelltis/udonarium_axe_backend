import { describe, expect, it } from 'vitest';

import { verifyPassword } from '../../../src/core/rooms/password.js';
import { createRoom, expiryKeyOf, readRoomMeta, roomKeysOf } from '../../../src/server/rooms/keys.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

const init = (roomKey: string, password = '') => ({
  roomKey,
  roomId: 'abc',
  name: 'room',
  password,
  creatorUserId: 'user-gm',
  host: 'backend.example',
});

describe('a room kept in Redis', () => {
  it('keeps its password only as a hash it can check', async () => {
    const key = freshKey();
    expect(await createRoom(connection.redis, key, init('locked', 'secret'), 3600)).toBe(true);
    expect(await createRoom(connection.redis, key, init('open'), 3600)).toBe(false);

    const locked = await readRoomMeta(connection.redis, key, 'locked');
    const open = await readRoomMeta(connection.redis, key, 'open');

    expect(locked?.password && verifyPassword('secret', locked.password)).toBe(true);
    expect(locked?.password && verifyPassword('wrong', locked.password)).toBe(false);
    expect(open).toEqual({ roomKey: 'open', password: null, host: 'backend.example' });
    expect(await connection.redis.hGet(roomKeysOf(key, 'locked').roles, 'user-gm')).toBe('gm');
  });

  it('is gone once never made, being deleted, or past its retention', async () => {
    const key = freshKey();
    await createRoom(connection.redis, key, init('deleting'), 3600);
    await createRoom(connection.redis, key, init('expired'), 3600);
    await connection.redis.hSet(roomKeysOf(key, 'deleting').meta, 'deleting', '1');
    await connection.redis.zAdd(expiryKeyOf(key), { score: Date.now() - 1, value: 'expired' });

    for (const roomKey of ['never', 'deleting', 'expired']) {
      expect(await readRoomMeta(connection.redis, key, roomKey)).toBeNull();
    }
  });
});
