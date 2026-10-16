import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

import { ASSET_NAME_HEADER } from '../../../contracts/protocol.js';
import type { ServerEnv } from './backend.js';
import { fail } from './errors.js';
import { isAllowedOrigin } from './origin.js';

const MAX_AGE_SECONDS = 86_400;

// 部屋・部屋のアセット・ログイン・アカウントの Origin は apiCors で確かめ済み
const apiHeaders = cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization', ASSET_NAME_HEADER],
  // 部屋のアセットを取るときに、置いたときの名前を読ませる
  exposeHeaders: [ASSET_NAME_HEADER],
  maxAge: MAX_AGE_SECONDS,
});

/**
 * 部屋・部屋のアセット・ログイン・アカウントのものは、許可した Origin からしか受けない。部屋の WebSocket の接続も同じ。
 * WebSocket の応答（101）にはヘッダーを足せないので、CORS のヘッダーは付けない。
 */
export const apiCors = (): MiddlewareHandler<ServerEnv> => async (c, next) => {
  if (!isAllowedOrigin(c.req.header('Origin'), c.var.config.allowedOrigins)) {
    return fail(c, 403, 'origin-not-allowed');
  }
  if (c.req.header('Upgrade')) return next();
  return apiHeaders(c, next);
};
