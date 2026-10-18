import { timingSafeEqual } from 'node:crypto';

import type { Account } from '../../../contracts/protocol.js';
import { base64url } from './tokens.js';

/** How many seconds the code given on the way back from a login can be used for. */
export const LOGIN_CODE_SECONDS = 5 * 60;
/** How many seconds a refresh token can be used for. */
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

/** The person's details as received from the login provider. */
export interface Profile {
  /**
   * The provider and the id there, put together (for example `discord:123`). The name of where the
   * account is kept.
   */
  accountKey: string;
  name: string;
  avatarUrl: string | null;
}

/** A secret for one use: the row's id, and what the hash stored in that row was made from. */
export interface Secret {
  id: string;
  secret: string;
}

/** What a login or a refresh hands over. The side that receives it signs the access token. */
export interface Session {
  account: Account;
  accountKey: string;
  refreshToken: Secret;
}

/** A refresh token made before it is written, and its hash (the SHA-256 in base64url). */
export interface IssuedToken {
  token: Secret;
  hash: string;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const randomText = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export const sha256 = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** Compares strings of the same length in the same time, wherever they differ. */
export const sameText = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** The code for one use, given on the way back from a login. */
export const newLoginCode = (): Secret => ({ id: randomText(12), secret: randomText(32) });

export const newRefreshToken = async (): Promise<IssuedToken> => {
  const token = { id: randomText(12), secret: randomText(32) };
  return { token, hash: await sha256(token.secret) };
};
