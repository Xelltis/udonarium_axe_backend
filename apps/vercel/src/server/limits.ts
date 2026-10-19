import type { LimitKind } from '../core/http/backend.js';
import { networkOf } from '../core/http/network.js';
import type { KeyOf, Redis } from './redis.js';

/** The window counted for each sender (milliseconds). */
export const LIMIT_WINDOW_MS = 60_000;

/** The limit for each window. The same as ratelimits in the Cloudflare version's wrangler.jsonc. */
export const LIMITS: Readonly<Record<LimitKind, number>> = {
  upload: 100,
  read: 600,
  room: 30,
  auth: 60,
};

/**
 * The sender's IP. Vercel sets x-real-ip and x-forwarded-for again itself, so a client cannot fake
 * them. The local server puts the connecting socket's address in x-real-ip before handing it on.
 */
export const clientIpOf = (request: Request): string =>
  request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

/**
 * Counts in Redis whether a sender (each /64 for IPv6) is within the limit. The window is
 * LIMIT_WINDOW_MS from that sender's first request. The key carries the host name the request came
 * to, so the counts do not mix with another deploy that uses the same Redis. A limit the operator
 * has tightened counts the request weight times.
 */
export const redisLimiter =
  (redis: Redis, key: KeyOf, limits: Readonly<Record<LimitKind, number>> = LIMITS) =>
  async (request: Request, kind: LimitKind, weight = 1): Promise<boolean> => {
    const name = key('rl', kind, new URL(request.url).host, networkOf(clientIpOf(request)));
    const [, count] = await redis
      .multi()
      .set(name, '0', { condition: 'NX', expiration: { type: 'PX', value: LIMIT_WINDOW_MS } })
      .incrBy(name, weight)
      .exec();
    return Number(count) <= limits[kind];
  };
