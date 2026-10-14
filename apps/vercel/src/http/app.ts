import { Hono } from 'hono';

import { onError } from './errors/handler.js';
import { configLoader } from './middlewares/config-loader.js';
import { createCorsMiddleware } from './middlewares/cors.js';
import { rootRoute } from './routes/root.js';
import { v1Routes } from './routes/v1/index.js';
import type { AppEnv } from './context.js';

export const createApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.route('/', rootRoute);
  app.use('/v1/*', configLoader(), createCorsMiddleware());
  app.route('/v1', v1Routes);
  return app;
};
