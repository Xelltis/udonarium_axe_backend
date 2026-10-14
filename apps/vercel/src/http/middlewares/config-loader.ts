import { env } from 'hono/adapter';
import type { MiddlewareHandler } from 'hono';

import { parseConfig } from '../../config/index.js';
import type { AppConfig } from '../../config/types.js';
import type { AppEnv } from '../context.js';

// Node.js ランタイムでは env(c) は process.env に解決され、インスタンスの
// 生存期間中は不変。リクエストごとにスキーマ検証を繰り返す必要はないため、
// ミドルウェア単位のクロージャに保持する。検証に失敗した場合は何も残らないので
// 次のリクエストで再試行される。
export const configLoader = (): MiddlewareHandler<AppEnv> => {
  let cached: AppConfig | undefined;

  return async (c, next) => {
    cached ??= parseConfig(env(c));
    c.set('config', cached);
    await next();
  };
};
