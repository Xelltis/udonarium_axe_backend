import { afterAll, beforeAll } from 'vitest';

import { connectRedis, keyOf } from '../../src/server/redis.js';
import type { Redis } from '../../src/server/redis.js';

/** テストの Redis。手元では `docker compose up -d redis`、CI ではサービスのコンテナ */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** テストごとに別の頭。同じ Redis を使うほかのテストと混ぜない */
export const freshKey = () => keyOf(`test:${crypto.randomUUID()}:`);

/** ファイルの中で使う Redis の接続。終わったら閉じる */
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
