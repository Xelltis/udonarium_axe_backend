import { Hono } from 'hono';
import { env } from 'hono/adapter';
import type { MiddlewareHandler } from 'hono';

import { parseServerConfig } from '../config/server.js';
import type { VercelServerConfig } from '../config/server.js';
import { sameText } from '../core/auth/secrets.js';
import type { ServerBackend, ServerEnv } from '../core/http/backend.js';
import type { Swept } from '../server/deps.js';
import { onError } from '../core/http/errors.js';
import { adminRoutes } from '../core/http/routes/admin.js';
import { serverRoutes } from '../core/http/routes/index.js';

/** The room server's routes. Their settings and error shape are separate from the SkyWay routes'. */
export const SERVER_PATHS = [
  '/v1/rooms',
  '/v1/rooms/*',
  '/v1/auth/*',
  '/v1/account',
  '/v1/account/*',
  '/v1/login/*',
  '/v1/contact',
  '/internal/sweep',
  '/admin',
  '/admin/*',
];

export interface ServerAppOptions {
  /** The environment variables, or process.env when not given. */
  env?: () => Record<string, string | undefined>;
  /** The room server that fits the settings. */
  backendFor: (config: VercelServerConfig) => Promise<ServerBackend>;
  /**
   * Deletes the rooms past their time to be deleted, and the assets that failed to be deleted.
   * keyed is whether the caller showed CRON_SECRET. Returns null when it did not sweep because it
   * swept a little while ago.
   */
  sweep: (config: VercelServerConfig, keyed: boolean) => Promise<Swept | null>;
}

type ServerAppEnv = ServerEnv & { Variables: { config: VercelServerConfig } };

/**
 * The room server's routes. Runs the same src/core routes as the Cloudflare version on a room
 * server kept in Redis and Blob. The settings are read once and then reused (they do not change
 * while the Node process lives). When they cannot be read, the next request reads them again.
 */
export const serverApp = (options: ServerAppOptions): Hono<ServerAppEnv> => {
  let cached: VercelServerConfig | undefined;
  const loader: MiddlewareHandler<ServerAppEnv> = async (c, next) => {
    cached ??= parseServerConfig(options.env ? options.env() : env(c));
    c.set('config', cached);
    c.set('backend', await options.backendFor(cached));
    await next();
  };
  const app = new Hono<ServerAppEnv>();
  app.onError(onError);
  for (const path of SERVER_PATHS) app.use(path, loader);
  app.route('/v1', serverRoutes());
  // The operator's dashboard. Only when ADMIN_DISCORD_IDS is set.
  app.route('/admin', adminRoutes());
  // The sweep Vercel Cron calls. When CRON_SECRET is set, checks the Authorization Vercel adds.
  // Without it anyone can call, so the sweep runs only once in a while.
  app.get('/internal/sweep', async (c) => {
    const config = c.get('config');
    const authorization = c.req.header('Authorization') ?? '';
    if (config.cronSecret && !sameText(authorization, `Bearer ${config.cronSecret}`)) {
      return c.body(null, 401);
    }
    const swept = await options.sweep(config, config.cronSecret !== null);
    return swept ? c.json(swept) : c.body(null, 429);
  });
  return app;
};
