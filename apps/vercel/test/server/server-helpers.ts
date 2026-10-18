import { parseServerConfig } from '../../src/config/server.js';
import { memoryBucket } from '../../src/server/assets/bucket.js';
import { createServerDeps } from '../../src/server/deps.js';
import type { DepsOptions } from '../../src/server/deps.js';
import type { Redis } from '../../src/server/redis.js';
import { REDIS_URL } from './redis-helpers.js';

export const LOGIN = {
  DISCORD_CLIENT_ID: 'id',
  DISCORD_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
};

/** The test room server's settings. The Redis prefix changes each time, so as not to mix with other tests. */
export const configOf = (env: Record<string, string> = {}) =>
  parseServerConfig({
    ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example',
    ...LOGIN,
    REDIS_URL,
    REDIS_KEY_PREFIX: `test:${crypto.randomUUID()}:`,
    BLOB_STORE_ID: 'memory',
    ...env,
  });

/** Makes what the room server uses, with the given Redis connection. */
export const depsOf = (redis: Redis, options: Partial<DepsOptions> = {}, env?: Record<string, string>) => {
  const bucket = memoryBucket();
  return createServerDeps(configOf(env), { bucketOf: () => bucket, ...options }, redis).then((deps) => ({
    ...deps,
    bucket,
  }));
};
