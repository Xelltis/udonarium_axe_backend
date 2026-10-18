import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

import { ASSET_NAME_HEADER } from '../../../contracts/protocol.js';
import type { ServerEnv } from './backend.js';
import { fail } from './errors.js';
import { isAllowedOrigin } from './origin.js';

const MAX_AGE_SECONDS = 86_400;

// The Origin for rooms, room assets, login and accounts has already been checked in apiCors.
const apiHeaders = cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization', ASSET_NAME_HEADER],
  // Lets the name an asset was stored with be read when a room asset is fetched.
  exposeHeaders: [ASSET_NAME_HEADER],
  maxAge: MAX_AGE_SECONDS,
});

/**
 * Requests for rooms, room assets, login and accounts are taken only from allowed Origins. The same
 * goes for connections to a room's WebSocket.
 * Headers cannot be added to the WebSocket response (101), so it gets no CORS headers.
 */
export const apiCors = (): MiddlewareHandler<ServerEnv> => async (c, next) => {
  if (!isAllowedOrigin(c.req.header('Origin'), c.var.config.allowedOrigins)) {
    return fail(c, 403, 'origin-not-allowed');
  }
  if (c.req.header('Upgrade')) return next();
  return apiHeaders(c, next);
};
