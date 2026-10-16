import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

import { isAllowedOrigin } from '../../core/http/origin.js';
import { AppError } from '../errors/app-error.js';
import type { AppEnv } from '../context.js';

// The Origin has already been checked by createCorsMiddleware below, so this echoes it as it is.
// Building cors() on every request would make the middleware and its options anew each time in a
// long-lived Fluid compute process, so it is fixed at module scope.
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
