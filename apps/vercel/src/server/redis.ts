import { RESP_TYPES, createClient } from 'redis';

/** Redis への接続。文字列で受ける */
export type Redis = ReturnType<typeof createClient>;

/** 同じ接続で、値をバイト列（Buffer）のまま受けるもの。部屋のオブジェクトは MessagePack で置く */
export type BinaryRedis = ReturnType<typeof binaryOf>;

export const binaryOf = (redis: Redis) =>
  redis.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });

/** つなぐ。切れたときは node-redis がつなぎ直す */
export const connectRedis = async (url: string): Promise<Redis> => {
  const redis = createClient({ url });
  redis.on('error', (err: unknown) => console.error('Redis error:', err));
  await redis.connect();
  return redis;
};

/**
 * 置き場所の名前。prefix（REDIS_KEY_PREFIX、既定は `axe:`）の下に置き、1つの Redis をいくつかの
 * デプロイで分けて使えるようにする
 */
export const keyOf =
  (prefix: string) =>
  (...parts: string[]): string =>
    `${prefix}${parts.join(':')}`;

export type KeyOf = ReturnType<typeof keyOf>;
