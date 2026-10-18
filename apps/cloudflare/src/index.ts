import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { cloudflareBackend } from './backend';
import { parseConfig } from './config';
import { onError } from './core/http/errors';
import { serverRoutes } from './core/http/routes/index';
import type { AppEnv } from './http/context';
import { skywayRoutes } from './skyway/routes';

export { AccountDurableObject } from './auth/account';
export { LobbyDurableObject } from './rooms/lobby';
export { RoomDurableObject } from './rooms/room';

/**
 * Checks the environment variables before going on. When some are missing, a ConfigError makes it a 500.
 * Rooms, the room list, accounts and assets are kept in this Worker's bindings. The same Worker can
 * issue SkyWay tokens too, for Axe delivered with SkyWay.
 */
const configLoader: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('config', parseConfig(c.env));
  c.set(
    'backend',
    cloudflareBackend(c.env, (work) => c.executionCtx.waitUntil(work))
  );
  await next();
};

const app = new Hono<AppEnv>();

app.onError(onError);
app.get('/', (c) => c.json({ message: 'Hello udonarium-axe-backend!' }));
app.use('/v1/*', configLoader);
app.route('/v1', skywayRoutes());
app.route('/v1', serverRoutes());

export default app;
