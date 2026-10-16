import { RESP_TYPES, createClient } from 'redis';

/** The connection to Redis. Takes values as strings. */
export type Redis = ReturnType<typeof createClient>;

/** The same connection, taking values as bytes (Buffer). The room's objects are kept as MessagePack. */
export type BinaryRedis = ReturnType<typeof binaryOf>;

export const binaryOf = (redis: Redis) => redis.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });

/** Connects. When the connection drops, node-redis reconnects. */
export const connectRedis = async (url: string): Promise<Redis> => {
  const redis = createClient({ url });
  redis.on('error', (err: unknown) => console.error('Redis error:', err));
  await redis.connect();
  return redis;
};

/**
 * The name something is kept under. It goes under prefix (REDIS_KEY_PREFIX, `axe:` by default),
 * so that several deploys can share one Redis.
 */
export const keyOf =
  (prefix: string) =>
  (...parts: string[]): string =>
    `${prefix}${parts.join(':')}`;

export type KeyOf = ReturnType<typeof keyOf>;
