import type { LimitKind } from '../core/http/backend.js';
import { networkOf } from '../core/http/network.js';
import type { KeyOf, Redis } from './redis.js';

/** 送信元ごとに数える窓（ミリ秒） */
export const LIMIT_WINDOW_MS = 60_000;

/** 窓ごとの上限。Cloudflare 版の wrangler.jsonc の ratelimits と同じ */
export const LIMITS: Readonly<Record<LimitKind, number>> = {
  upload: 100,
  read: 600,
  room: 30,
  auth: 60,
};

/**
 * 送信元の IP。Vercel は x-real-ip と x-forwarded-for を自分で付け直すので、クライアントには偽れない。
 * 手元のサーバーでは、つないできたソケットの番地を x-real-ip に入れてから渡す
 */
export const clientIpOf = (request: Request): string =>
  request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

/**
 * 送信元（IPv6 は /64 ごと）の数が上限のうちかを、Redis で数える。窓は、その送信元の最初の1回から
 * LIMIT_WINDOW_MS のあいだ。鍵の頭に受けたホスト名を付けて、同じ Redis を使う別のデプロイと数を混ぜない
 */
export const redisLimiter =
  (redis: Redis, key: KeyOf, limits: Readonly<Record<LimitKind, number>> = LIMITS) =>
  async (request: Request, kind: LimitKind): Promise<boolean> => {
    const name = key('rl', kind, new URL(request.url).host, networkOf(clientIpOf(request)));
    const [, count] = await redis
      .multi()
      .set(name, '0', { condition: 'NX', expiration: { type: 'PX', value: LIMIT_WINDOW_MS } })
      .incr(name)
      .exec();
    return Number(count) <= limits[kind];
  };
