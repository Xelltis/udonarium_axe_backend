import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { parseConfig } from './config';
import type { AppEnv } from './http/context';
import { accountRoutes, authRoutes, loginRoutes } from './auth/routes';
import { apiCors } from './http/cors';
import { onError } from './http/errors';
import { roomRoutes } from './rooms/routes';

export { AccountDurableObject } from './auth/account';
export { LobbyDurableObject } from './rooms/lobby';
export { RoomDurableObject } from './rooms/room';

/** 環境変数を確かめてから先へ進める。足りなければ ConfigError で 500 になる */
const configLoader: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('config', parseConfig(c.env));
  await next();
};

const app = new Hono<AppEnv>();

app.onError(onError);
app.get('/', (c) => c.json({ message: 'Hello udonarium-axe-backend!' }));
app.use('/v1/*', configLoader);
for (const path of ['/v1/rooms', '/v1/auth', '/v1/account']) {
  app.use(path, apiCors());
  app.use(`${path}/*`, apiCors());
}
app.route('/v1/rooms', roomRoutes);
app.route('/v1/auth', authRoutes);
app.route('/v1/account', accountRoutes);
// ブラウザがページとして開くもの（Discord への行き来）。Origin は付かないので確かめない
app.route('/v1/login', loginRoutes);

export default app;
