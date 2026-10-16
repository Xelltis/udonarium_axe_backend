import type { Context } from 'hono';

import { readToken } from '../auth/tokens.js';
import type { Claims } from '../auth/tokens.js';
import type { LoginConfig } from '../config/login.js';

/** Authorization: Bearer に付いたもの。無ければ null */
const bearerTokenOf = (c: Context): string | null => {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
};

/** Authorization: Bearer のアクセストークンを確かめる。無いか無効なら null */
export const bearerOf = (c: Context, login: LoginConfig): Claims<'access'> | null => {
  const token = bearerTokenOf(c);
  return token === null ? null : readToken(token, 'access', login.sessionSecret);
};

/**
 * 部屋のアセットのトークン。Authorization: Bearer に付いたもので、この部屋のために部屋のサーバーが
 * 渡したものだけを受ける。ログインを置いていない部屋のサーバーには部屋が無いので、受けるものも無い
 */
export const assetClaimsOf = (
  c: Context,
  login: LoginConfig | null,
  roomKey: string,
): Claims<'asset'> | null => {
  const token = bearerTokenOf(c);
  if (!login || token === null) return null;
  const claims = readToken(token, 'asset', login.sessionSecret);
  return claims?.room === roomKey ? claims : null;
};

/** Content-Length の値。無いか、0 以上の整数でなければ null */
export const declaredLengthOf = (c: Context): number | null => {
  const header = c.req.header('Content-Length');
  const length = Number(header);
  return header && Number.isInteger(length) && length >= 0 ? length : null;
};
