import { Hono } from 'hono';

import type { ServerEnv } from '../backend.js';
import { apiCors } from '../cors.js';
import { accountRoutes, authRoutes, loginRoutes } from './auth.js';
import { roomRoutes } from './rooms.js';

/**
 * 部屋のサーバーの経路（/v1 の下）。どの部屋のサーバーでも同じ順に確かめ、同じ形で答える。
 * config と backend は、部屋のサーバーが先に置いておく
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
  // ブラウザがページとして開くもの（Discord への行き来）。Origin は付かないので確かめない
  routes.route('/login', loginRoutes);
  return routes;
};
