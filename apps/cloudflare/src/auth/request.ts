import type { Context } from 'hono';

import type { LoginConfig } from '../config';
import type { AppEnv } from '../http/context';
import { readToken } from '../core/auth/tokens';
import type { Claims } from '../core/auth/tokens';

/** アカウントの Durable Object */
export const accountOf = (env: Env, accountKey: string) => env.ACCOUNTS.getByName(accountKey);

/** Authorization: Bearer のアクセストークンを確かめる。無いか無効なら null */
export const bearerOf = (c: Context<AppEnv>, login: LoginConfig): Claims<'access'> | null => {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ')
    ? readToken(header.slice('Bearer '.length), 'access', login.sessionSecret)
    : null;
};
