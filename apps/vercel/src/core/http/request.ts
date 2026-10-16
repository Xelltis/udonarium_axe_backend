import type { Context } from 'hono';

import { readToken } from '../auth/tokens.js';
import type { Claims } from '../auth/tokens.js';
import type { LoginConfig } from '../config/login.js';

/** What comes with Authorization: Bearer. Null when there is none. */
const bearerTokenOf = (c: Context): string | null => {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
};

/** Checks the access token in Authorization: Bearer. Null when it is missing or not valid. */
export const bearerOf = (c: Context, login: LoginConfig): Claims<'access'> | null => {
  const token = bearerTokenOf(c);
  return token === null ? null : readToken(token, 'access', login.sessionSecret);
};

/**
 * The token for room assets. Only one that comes with Authorization: Bearer and that the room
 * server handed out for this room is taken. A room server with no login set up has no rooms, so it
 * has nothing to take either.
 */
export const assetClaimsOf = (c: Context, login: LoginConfig | null, roomKey: string): Claims<'asset'> | null => {
  const token = bearerTokenOf(c);
  if (!login || token === null) return null;
  const claims = readToken(token, 'asset', login.sessionSecret);
  return claims?.room === roomKey ? claims : null;
};

/** The value of Content-Length. Null when it is missing or is not a whole number of 0 or more. */
export const declaredLengthOf = (c: Context): number | null => {
  const header = c.req.header('Content-Length');
  const length = Number(header);
  return header && Number.isInteger(length) && length >= 0 ? length : null;
};
