import { describe, expect, it, vi } from 'vitest';

import { memoryBucket } from '../../src/server/assets/bucket.js';
import { backendProvider, createServerDeps } from '../../src/server/deps.js';
import { useRedis } from './redis-helpers.js';
import { configOf, depsOf } from './server-helpers.js';

const connection = useRedis();

describe('the server dependencies', () => {
  it('connect to Redis on their own when not handed a connection', async () => {
    const deps = await createServerDeps(configOf(), { bucketOf: () => memoryBucket() });

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
    expect(await provider.sweep(withoutStore)).toBe(0);
    expect(await provider.sweep(config)).toBe(0);
    expect(provider.depsFor(broken)).toBeUndefined();
    (await provider.depsFor(config))?.redis.destroy();
  });
});
