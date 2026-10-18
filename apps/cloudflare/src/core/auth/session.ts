import type { TokenResponse } from '../../../contracts/protocol.js';
import type { LoginConfig } from '../config/login.js';
import type { Secret, Session } from './secrets.js';
import { ACCESS_TOKEN_SECONDS, base64url, signToken } from './tokens.js';

// The code given on the way back from a login and the refresh token take the form
// "account key.row id.secret". The key tells which account's Durable Object to ask.

const decoder = new TextDecoder();

export const packSecret = (accountKey: string, secret: Secret): string =>
  `${base64url(new TextEncoder().encode(accountKey))}.${secret.id}.${secret.secret}`;

/** Reads the form packSecret makes. Null when the form is different. */
export const unpackSecret = (text: string): { accountKey: string; secret: Secret } | null => {
  const match = /^([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(text);
  if (!match) return null;
  const [, key, id, secret] = match;
  try {
    const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    return { accountKey: decoder.decode(bytes), secret: { id, secret } };
  } catch {
    // It cannot be read as base64.
    return null;
  }
};

/** The set of tokens handed to Axe. The access token is signed here. */
export const tokensOf = (session: Session, login: LoginConfig): TokenResponse => ({
  accessToken: signToken<'access'>(
    {
      aud: 'access',
      sub: session.accountKey,
      uid: session.account.userId,
      name: session.account.name,
    },
    ACCESS_TOKEN_SECONDS,
    login.sessionSecret
  ),
  expiresIn: ACCESS_TOKEN_SECONDS,
  refreshToken: packSecret(session.accountKey, session.refreshToken),
  account: session.account,
});
