import type { Context } from 'hono';

import type { AppEnv } from './context';
import { networkOf } from './network';

/** 送信元。IPv6 は /64 ごとにまとめる */
export const networkOfRequest = (c: Context<AppEnv>): string =>
  networkOf(c.req.header('CF-Connecting-IP') ?? 'unknown');

/**
 * すべての鍵でレート制限に収まっていれば true。どれか1つでも超えたら false。
 *
 * namespace_id は同じアカウントの Worker どうしで共有されるので、鍵の頭に受けたホスト名を付けて、
 * 同じアカウントに置いた別のインスタンスと数えるものを混ぜない。
 */
export const withinLimits = async (
  c: Context<AppEnv>,
  limiter: RateLimit,
  keys: string[],
): Promise<boolean> => {
  const host = new URL(c.req.url).host;
  const outcomes = await Promise.all(keys.map((key) => limiter.limit({ key: `${host}/${key}` })));
  return outcomes.every(({ success }) => success);
};
