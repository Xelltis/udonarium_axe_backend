import { afterAll, beforeAll } from 'vitest';

import { connectRedis, keyOf } from '../../src/server/redis.js';
import type { Redis } from '../../src/server/redis.js';

/** The tests' Redis. `docker compose up -d redis` locally, and a service container on CI. */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** A different prefix for each test, so it does not mix with other tests that use the same Redis. */
export const freshKey = () => keyOf(`test:${crypto.randomUUID()}:`);

/** The Redis connection used within a file. It is closed at the end. */
export const useRedis = (): { readonly redis: Redis } => {
  const holder = {} as { redis: Redis };
  beforeAll(async () => {
    holder.redis = await connectRedis(REDIS_URL);
  });
  afterAll(() => {
    holder.redis.destroy();
  });
  return holder;
};
