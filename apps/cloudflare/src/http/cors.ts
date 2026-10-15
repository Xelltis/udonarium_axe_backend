import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from './context';
import { fail } from './errors';
import { isAllowedOrigin } from './origin';

const MAX_AGE_SECONDS = 86_400;

// 部屋・部屋のアセット・ログイン・アカウントの Origin は apiCors で確かめ済み
const apiHeaders = cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: MAX_AGE_SECONDS,
});

/**
 * 部屋・部屋のアセット・ログイン・アカウントのものは、許可した Origin からしか受けない。部屋の WebSocket の接続も同じ。
 * WebSocket の応答（101）にはヘッダーを足せないので、CORS のヘッダーは付けない。
 */
export const apiCors = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!isAllowedOrigin(c.req.header('Origin'), c.var.config.allowedOrigins)) {
    return fail(c, 403, 'origin-not-allowed');
  }
  if (c.req.header('Upgrade')) return next();
  return apiHeaders(c, next);
};
