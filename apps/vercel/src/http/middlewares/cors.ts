import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

import { isAllowedOrigin } from '../../infra/url/origin.js';
import { AppError } from '../errors/app-error.js';
import type { AppEnv } from '../context.js';

// Origin は下の createCorsMiddleware で検証済みなので、ここではそのまま echo する。
// リクエストごとに cors() を組み立てると、Fluid compute の長命プロセスでは
// 毎回ミドルウェアとオプションを再生成することになるためモジュールスコープに固定する。
const corsMiddleware = cors({
  origin: (origin) => origin,
  allowHeaders: ['Content-Type', 'Accept'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  maxAge: 86_400,
});

export const createCorsMiddleware = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const { allowedOrigins } = c.var.config.cors;
  const requestOrigin = c.req.header('Origin');
  if (!requestOrigin) {
    throw new AppError('ORIGIN_REQUIRED', 400, 'Origin header is required.');
  }
  if (!isAllowedOrigin(requestOrigin, allowedOrigins)) {
    throw new AppError('ORIGIN_FORBIDDEN', 403, 'Origin is not allowed.');
  }
  return corsMiddleware(c, next);
};
