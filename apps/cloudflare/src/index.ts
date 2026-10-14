import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { assetRoutes } from './assets/routes';
import { parseConfig } from './config';
import type { AppEnv } from './http/context';
import { assetCors } from './http/cors';
import { onError } from './http/errors';

/** 環境変数を確かめてから先へ進める。足りなければ ConfigError で 500 になる */
const configLoader: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('config', parseConfig(c.env));
  await next();
};

const app = new Hono<AppEnv>();

app.onError(onError);
app.get('/', (c) => c.json({ message: 'Hello udonarium-axe-backend!' }));
app.use('/v1/*', configLoader);
app.use('/v1/assets/*', assetCors());
app.route('/v1/assets', assetRoutes);

export default app;
