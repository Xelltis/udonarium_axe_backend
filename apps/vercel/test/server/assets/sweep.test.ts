import { afterEach, describe, expect, it, vi } from 'vitest';

import { roomAssetKey } from '../../../src/core/assets/keys.js';
import { assetIndexOf } from '../../../src/server/assets/backend.js';
import { memoryBucket } from '../../../src/server/assets/bucket.js';
import { ORPHAN_AGE_MS, orphanSweeper } from '../../../src/server/assets/sweep.js';
import { roomKeysOf } from '../../../src/server/rooms/keys.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('the sweep of assets left behind', () => {
  it('takes away what is old and belongs to no room, or to no index, or was never finished, and leaves the rest', async () => {
    const key = freshKey();
    const bucket = memoryBucket();
    await connection.redis.hSet(roomKeysOf(key, 'here').meta, 'roomKey', 'here');
    await connection.redis.hSet(assetIndexOf(key, 'here'), ID, '{}');
    const old = Date.now() - ORPHAN_AGE_MS - 1;
    const put = async (path: string, uploadedAt: number) => {
      await bucket.put(path, new Uint8Array(), '');
      bucket.age(path, uploadedAt);
    };
    await put(roomAssetKey('here', ID), old);
    await put(roomAssetKey('here', OTHER), old);
    await put(roomAssetKey('gone', ID), old);
    await put(roomAssetKey('gone', OTHER), Date.now());
    await put('rooms//stray', old);
    await put('blocked/x', old);
    await put(`uploads/here/${ID}/old`, old);
    await put(`uploads/here/${ID}/new`, Date.now());

    expect(await orphanSweeper(connection.redis, key, bucket)()).toBe(4);

    expect(bucket.paths().sort()).toEqual(
      [roomAssetKey('here', ID), roomAssetKey('gone', OTHER), 'blocked/x', `uploads/here/${ID}/new`].sort()
    );
  });

  it('goes on from where it stopped, and starts over once through', async () => {
    const key = freshKey();
    const bucket = memoryBucket();
    const list = vi.spyOn(bucket, 'list').mockResolvedValueOnce({ items: [], cursor: 'next' });
    const sweep = orphanSweeper(connection.redis, key, bucket);

    await sweep();
    expect(await connection.redis.get(key('sweep', 'blob-cursor'))).toBe('next');
    await sweep();

    expect(list.mock.calls).toEqual([
      ['', null],
      ['', 'next'],
    ]);
    expect(await connection.redis.exists(key('sweep', 'blob-cursor'))).toBe(0);
  });
});
