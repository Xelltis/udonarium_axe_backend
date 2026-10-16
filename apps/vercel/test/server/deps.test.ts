import { describe, expect, it, vi } from 'vitest';

import { MAX_PUT_BYTES } from '../../src/server/assets/backend.js';
import { memoryBucket } from '../../src/server/assets/bucket.js';
import { localBucket } from '../../src/server/assets/local-bucket.js';
import { ORPHAN_SWEEP_EVERY, backendProvider, createServerDeps } from '../../src/server/deps.js';
import { useRedis } from './redis-helpers.js';
import { configOf, depsOf } from './server-helpers.js';

const connection = useRedis();

describe('the server dependencies', () => {
  it('connect to Redis on their own when not handed a connection, and keep assets in Blob', async () => {
    const deps = await createServerDeps(configOf(), {});

    expect(await deps.redis.ping()).toBe('PONG');
    deps.redis.destroy();
  });

  it('keep the work that goes on after an answer from failing loudly, and drop login for the rooms told to', async () => {
    const withoutLogin = new Set(['quiet']);
    const deps = await depsOf(connection.redis, { withoutLogin });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const secrets = await Promise.all(
      ['quiet', 'loud'].map((roomKey) =>
        deps.runtime.withRoom(roomKey, (room) => room.sessionSecret()),
      ),
    );
    await deps.runtime.withRoom('quiet', (room) => room.defer(Promise.reject(new Error('later'))));

    expect(secrets).toEqual([null, 'test-session-secret-0123456789abcdef']);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('sweep the assets left behind once in so many stored, and say so when they cannot', async () => {
    const deferred: Promise<unknown>[] = [];
    const bucket = memoryBucket();
    const deps = await depsOf(connection.redis, {
      bucketOf: () => bucket,
      defer: (work) => void deferred.push(work),
    });
    await bucket.put('rooms/gone/x', new Uint8Array(), '');
    bucket.age('rooms/gone/x', 0);
    const storeTimes = async (times: number) => {
      for (let i = 0; i < times; i++) deps.assets.afterStore();
      await Promise.all(deferred);
    };

    await storeTimes(ORPHAN_SWEEP_EVERY - 1);
    expect(bucket.paths()).toEqual(['rooms/gone/x']);
    await storeTimes(1);
    expect(bucket.paths()).toEqual([]);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(bucket, 'list').mockRejectedValueOnce(new Error('blob down'));
    await storeTimes(ORPHAN_SWEEP_EVERY);
    expect(error).toHaveBeenCalledWith('Asset sweep failed:', expect.any(Error));
    error.mockRestore();
  });

  it('tell a room to have big assets put up straight to the store, unless they go to a directory', async () => {
    const policyOf = async (deps: Awaited<ReturnType<typeof depsOf>>) =>
      deps.runtime.withRoom('room', (room) => room.assetUploadPolicy());

    const toStore = await policyOf(await depsOf(connection.redis));
    const toDirectory = await policyOf(
      await depsOf(connection.redis, { bucketOf: () => localBucket('/nowhere') }),
    );

    expect(toStore).toEqual({ maxPutBytes: MAX_PUT_BYTES, directUpload: true });
    expect(toDirectory).toBeNull();
  });

  it('sign nothing in rooms of a server without login', async () => {
    const deps = await depsOf(
      connection.redis,
      {},
      {
        DISCORD_CLIENT_ID: '',
        DISCORD_CLIENT_SECRET: '',
        SESSION_SECRET: '',
      },
    );

    expect(await deps.runtime.withRoom('room', (room) => room.sessionSecret())).toBeNull();
  });

  it('are made once per Redis, without a store when there is none, and again after a failure', async () => {
    const provider = backendProvider({ bucketOf: () => memoryBucket() });
    const withoutStore = configOf({
      REDIS_URL: '',
      DISCORD_CLIENT_ID: '',
      DISCORD_CLIENT_SECRET: '',
      SESSION_SECRET: '',
    });
    const storeless = await provider.backendFor(withoutStore);
    const broken = configOf({ REDIS_URL: 'not a url' });

    await expect(provider.backendFor(broken)).rejects.toThrow();
    await expect(provider.backendFor(broken)).rejects.toThrow();
    const config = configOf();
    await provider.backendFor(config);
    await provider.backendFor(config);

    expect(await storeless.lobby.list()).toEqual([]);
    expect(await provider.sweep(withoutStore)).toEqual({ rooms: 0, assets: 0 });
    expect(await provider.sweep(config)).toEqual({ rooms: 0, assets: 0 });
    expect(provider.depsFor(broken)).toBeUndefined();
    (await provider.depsFor(config))?.redis.destroy();
  });
});
