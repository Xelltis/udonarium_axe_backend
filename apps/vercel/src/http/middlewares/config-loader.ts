import { env } from 'hono/adapter';
import type { MiddlewareHandler } from 'hono';

import { parseConfig } from '../../config/index.js';
import type { AppConfig } from '../../config/types.js';
import type { AppEnv } from '../context.js';

// On the Node.js runtime, env(c) resolves to process.env, which does not change while the
// instance lives. There is no need to check the schema again on every request, so the result is
// kept in a closure for each middleware. When the check fails nothing is kept, so the next
// request tries again.
export const configLoader = (): MiddlewareHandler<AppEnv> => {
  let cached: AppConfig | undefined;

  return async (c, next) => {
    cached ??= parseConfig(env(c));
    c.set('config', cached);
    await next();
  };
};
