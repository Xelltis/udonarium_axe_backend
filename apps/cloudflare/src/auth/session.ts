import type { Context } from 'hono';

import type { TokenResponse } from '../../contracts/protocol';
import type { LoginConfig } from '../config';
import type { AppEnv } from '../http/context';
import type { Secret, Session } from './account';
import { ACCESS_TOKEN_SECONDS, base64url, readToken, signToken } from './tokens';
import type { Claims } from './tokens';

// ログインから戻ったときのコードとリフレッシュトークンは「アカウントの鍵.行の ID.秘密」の形にする。
// 鍵から、どのアカウントの Durable Object に尋ねればよいかがわかる。

const decoder = new TextDecoder();

export const packSecret = (accountKey: string, secret: Secret): string =>
  `${base64url(new TextEncoder().encode(accountKey))}.${secret.id}.${secret.secret}`;

/** packSecret の形を読む。形が違えば null */
export const unpackSecret = (text: string): { accountKey: string; secret: Secret } | null => {
  const match = /^([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(text);
  if (!match) return null;
  const [, key, id, secret] = match;
  try {
    const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
      char.charCodeAt(0),
    );
    return { accountKey: decoder.decode(bytes), secret: { id, secret } };
  } catch {
    // base64 として読めない
    return null;
  }
};

/** アカウントの Durable Object */
export const accountOf = (env: Env, accountKey: string) => env.ACCOUNTS.getByName(accountKey);

/** Axe に渡すトークンの組。アクセストークンはここで署名する */
export const tokensOf = (session: Session, login: LoginConfig): TokenResponse => ({
  accessToken: signToken<'access'>(
    {
      aud: 'access',
      sub: session.accountKey,
      uid: session.account.userId,
      name: session.account.name,
    },
    ACCESS_TOKEN_SECONDS,
    login.sessionSecret,
  ),
  expiresIn: ACCESS_TOKEN_SECONDS,
  refreshToken: packSecret(session.accountKey, session.refreshToken),
  account: session.account,
});

/** Authorization: Bearer のアクセストークンを確かめる。無いか無効なら null */
export const bearerOf = (c: Context<AppEnv>, login: LoginConfig): Claims<'access'> | null => {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ')
    ? readToken(header.slice('Bearer '.length), 'access', login.sessionSecret)
    : null;
};
