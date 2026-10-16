import { timingSafeEqual } from 'node:crypto';

import type { Account } from '../../../contracts/protocol.js';
import { base64url } from './tokens.js';

/** ログインから戻ったときのコードが使える秒数 */
export const LOGIN_CODE_SECONDS = 5 * 60;
/** リフレッシュトークンが使える秒数 */
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

/** ログインの提供元から受け取った人の情報 */
export interface Profile {
  /** 提供元と、そこでの ID を組にしたもの（例：`discord:123`）。アカウントを置く場所の名前 */
  accountKey: string;
  name: string;
  avatarUrl: string | null;
}

/** 使い捨ての秘密。行の ID と、その行に置いたハッシュの元 */
export interface Secret {
  id: string;
  secret: string;
}

/** ログインやリフレッシュで渡すもの。アクセストークンは受けた側が署名する */
export interface Session {
  account: Account;
  accountKey: string;
  refreshToken: Secret;
}

/** 書き込む前に作っておくリフレッシュトークンと、そのハッシュ（SHA-256 の base64url） */
export interface IssuedToken {
  token: Secret;
  hash: string;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const randomText = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

export const sha256 = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** 同じ長さの文字列を、どこで違っても同じ時間で比べる */
export const sameText = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** ログインから戻ったときの使い捨てのコード */
export const newLoginCode = (): Secret => ({ id: randomText(12), secret: randomText(32) });

export const newRefreshToken = async (): Promise<IssuedToken> => {
  const token = { id: randomText(12), secret: randomText(32) };
  return { token, hash: await sha256(token.secret) };
};
