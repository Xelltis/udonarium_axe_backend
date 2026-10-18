import { Hono } from 'hono';

import type { ServerEnv } from '../backend.js';
import { apiCors } from '../cors.js';
import { accountRoutes, authRoutes, loginRoutes } from './auth.js';
import { roomRoutes } from './rooms.js';

/**
 * The room server's routes (under /v1). Every room server checks things in the same order and
 * answers in the same form.
 * The room server sets config and backend beforehand.
 */
export const serverRoutes = (): Hono<ServerEnv> => {
  const routes = new Hono<ServerEnv>();
  for (const path of ['/rooms', '/auth', '/account']) {
    routes.use(path, apiCors());
    routes.use(`${path}/*`, apiCors());
  }
  routes.route('/rooms', roomRoutes);
  routes.route('/auth', authRoutes);
  routes.route('/account', accountRoutes);
  // What a browser opens as a page (the trip to Discord and back). It carries no Origin, so that is
  // not checked.
  routes.route('/login', loginRoutes);
  return routes;
};
