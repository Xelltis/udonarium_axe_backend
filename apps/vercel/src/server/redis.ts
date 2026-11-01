import { RESP_TYPES, createClient } from 'redis';

/**
 * A client on the terms node-redis 5 had by default, which node-redis 6 changed: RESP2 replies (and
 * with them no maintenance notifications), no time limit on a command, and TCP keep-alive from 5
 * seconds idle. duplicate() and withTypeMapping() carry them over.
 */
const clientOf = (url: string) =>
  createClient({ url, RESP: 2, socket: { keepAliveInitialDelay: 5000 }, commandOptions: { timeout: undefined } });

/** The connection to Redis. Takes values as strings. */
export type Redis = ReturnType<typeof clientOf>;

/** The same connection, taking values as bytes (Buffer). The room's objects are kept as MessagePack. */
export type BinaryRedis = ReturnType<typeof binaryOf>;

export const binaryOf = (redis: Redis) => redis.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });

/** Connects. When the connection drops, node-redis reconnects. */
export const connectRedis = async (url: string): Promise<Redis> => {
  const redis = clientOf(url);
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
