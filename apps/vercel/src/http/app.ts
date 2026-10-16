import { Hono } from 'hono';

import { onError } from './errors/handler.js';
import { configLoader } from './middlewares/config-loader.js';
import { createCorsMiddleware } from './middlewares/cors.js';
import { rootRoute } from './routes/root.js';
import { v1Routes } from './routes/v1/index.js';
import { serverApp } from './server.js';
import type { ServerAppOptions } from './server.js';
import type { AppEnv } from './context.js';

/** The routes that issue SkyWay tokens. Their settings, CORS and error shape are separate from the room server's. */
const SKYWAY_PATHS = ['/v1/status', '/v1/skyway/*', '/v1/skyway2023/*'];

export interface AppOptions {
  /** The room server's routes. Without them, only SkyWay tokens are issued. */
  server?: ServerAppOptions;
}

export const createApp = (options: AppOptions = {}): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.route('/', rootRoute);
  if (options.server) app.route('/', serverApp(options.server));
  for (const path of SKYWAY_PATHS) app.use(path, configLoader(), createCorsMiddleware());
  app.route('/v1', v1Routes);
  return app;
};
