import { Hono } from 'hono';
import { env } from 'hono/adapter';
import type { MiddlewareHandler } from 'hono';

import { parseServerConfig } from '../config/server.js';
import type { VercelServerConfig } from '../config/server.js';
import { sameText } from '../core/auth/secrets.js';
import type { ServerBackend, ServerEnv } from '../core/http/backend.js';
import { onError } from '../core/http/errors.js';
import { serverRoutes } from '../core/http/routes/index.js';

/** 部屋のサーバーの経路。SkyWay の経路とは、設定もエラーの形も別 */
export const SERVER_PATHS = [
  '/v1/rooms',
  '/v1/rooms/*',
  '/v1/auth/*',
  '/v1/account',
  '/v1/account/*',
  '/v1/login/*',
  '/internal/sweep',
];

export interface ServerAppOptions {
  /** 環境変数。置かなければ process.env */
  env?: () => Record<string, string | undefined>;
  /** 設定に合う部屋のサーバー */
  backendFor: (config: VercelServerConfig) => Promise<ServerBackend>;
  /** 消す時刻を過ぎた部屋を消す。消した部屋の数 */
  sweep: (config: VercelServerConfig) => Promise<number>;
}

type ServerAppEnv = ServerEnv & { Variables: { config: VercelServerConfig } };

/**
 * 部屋のサーバーの経路。Cloudflare 版と同じ src/core の経路を、Redis と Blob に置く部屋のサーバーで動かす。
 * 設定は1度読んだら使い回す（Node のプロセスのあいだ変わらない）。読めなければ次のリクエストで読み直す
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
  // Vercel Cron が呼ぶ掃除。CRON_SECRET を置いていれば、Vercel が付ける Authorization を確かめる
  app.get('/internal/sweep', async (c) => {
    const config = c.get('config');
    const authorization = c.req.header('Authorization') ?? '';
    if (config.cronSecret && !sameText(authorization, `Bearer ${config.cronSecret}`)) {
      return c.body(null, 401);
    }
    return c.json({ swept: await options.sweep(config) });
  });
  return app;
};
