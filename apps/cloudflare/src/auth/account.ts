import { DurableObject } from 'cloudflare:workers';

import { ACCOUNT_USER_ID_PREFIX } from '../../contracts/protocol';
import type { Account } from '../../contracts/protocol';
import { base64url } from './tokens';

/** ログインから戻ったときのコードが使える秒数 */
export const LOGIN_CODE_SECONDS = 5 * 60;
/** リフレッシュトークンが使える秒数 */
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

/** ログインの提供元から受け取った人の情報 */
export interface Profile {
  /** 提供元と、そこでの ID を組にしたもの（例：`discord:123`）。この Durable Object の名前 */
  accountKey: string;
  name: string;
  avatarUrl: string | null;
}

/** 使い捨ての秘密。行の ID と、その行に置いたハッシュの元 */
export interface Secret {
  id: string;
  secret: string;
}

/** ログインやリフレッシュで渡すもの。アクセストークンは Worker が署名する */
export interface Session {
  account: Account;
  accountKey: string;
  refreshToken: Secret;
}

interface ProfileRow extends Record<string, SqlStorageValue> {
  account_key: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const randomText = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

const sha256 = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** 同じ長さの文字列を、どこで違っても同じ時間で比べる */
const sameText = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.length === right.length && crypto.subtle.timingSafeEqual(left, right);
};

/**
 * ログインした1人ぶんのアカウント。名前は accountKey（`discord:<ID>`）。
 *
 * 人の情報、ログインから戻ったときの使い捨てのコード、リフレッシュトークンを置く。
 * どれも秘密はハッシュにして置き、そのままは置かない。D1 を使わないので、デプロイで作るものが増えない。
 */
export class AccountDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS login_codes (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      family TEXT NOT NULL,
      hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /**
   * ログインした。人の情報を置き直し（ユーザー ID は初めてのときに決めたまま）、
   * Axe に渡す使い捨てのコードを作る。challenge は、Axe がログインを始めるときに渡した code_challenge
   */
  async signIn(profile: Profile, challenge: string): Promise<Secret> {
    const sql = this.ctx.storage.sql;
    const now = nowSeconds();
    sql.exec(
      `INSERT INTO profile (id, account_key, user_id, name, avatar_url, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url,
         updated_at = excluded.updated_at`,
      profile.accountKey,
      `${ACCOUNT_USER_ID_PREFIX}${crypto.randomUUID()}`,
      profile.name,
      profile.avatarUrl,
      now,
      now,
    );
    this.sweep();
    const code = { id: randomText(12), secret: randomText(32) };
    sql.exec(
      'INSERT INTO login_codes (id, hash, challenge, expires_at) VALUES (?, ?, ?, ?)',
      code.id,
      await sha256(code.secret),
      challenge,
      now + LOGIN_CODE_SECONDS,
    );
    return code;
  }

  /**
   * ログインから戻ったときのコードを、リフレッシュトークンに替える。コードは1度しか使えない。
   * verifier は、code_challenge の元になった code_verifier（SHA-256 の base64url が challenge と合うもの）
   */
  async redeem(code: Secret, verifier: string): Promise<Session | null> {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ hash: string; challenge: string; expires_at: number }>(
        'SELECT hash, challenge, expires_at FROM login_codes WHERE id = ?',
        code.id,
      )
      .toArray()[0];
    if (!row) return null;
    sql.exec('DELETE FROM login_codes WHERE id = ?', code.id);
    const valid =
      row.expires_at > nowSeconds() &&
      sameText(await sha256(code.secret), row.hash) &&
      sameText(await sha256(verifier), row.challenge);
    return valid ? this.startSession(crypto.randomUUID()) : null;
  }

  /**
   * リフレッシュトークンを使い、同じ系統の新しいものに替える。
   * もう使ったものがまた来たら、盗まれたとみなして、その系統をすべて無効にする
   */
  async refresh(token: Secret): Promise<Session | null> {
    const sql = this.ctx.storage.sql;
    const row = await this.findRefreshToken(token);
    if (!row) return null;
    if (row.used === 1) {
      sql.exec('DELETE FROM refresh_tokens WHERE family = ?', row.family);
      return null;
    }
    sql.exec('UPDATE refresh_tokens SET used = 1 WHERE id = ?', token.id);
    return this.startSession(row.family);
  }

  /** ログアウトした。そのリフレッシュトークンの系統をすべて無効にする */
  async signOut(token: Secret): Promise<void> {
    const row = await this.findRefreshToken(token);
    if (row) this.ctx.storage.sql.exec('DELETE FROM refresh_tokens WHERE family = ?', row.family);
  }

  /** ログインしている人の情報。消したあとなら null */
  account(): Account | null {
    const row = this.ctx.storage.sql
      .exec<ProfileRow>('SELECT account_key, user_id, name, avatar_url FROM profile')
      .toArray()[0];
    return row ? { userId: row.user_id, name: row.name, avatarUrl: row.avatar_url } : null;
  }

  /** アカウントを消す。人の情報もトークンもすべて消える */
  async erase(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.migrate();
  }

  private async findRefreshToken(token: Secret): Promise<{ family: string; used: number } | null> {
    const row = this.ctx.storage.sql
      .exec<{ family: string; hash: string; expires_at: number; used: number }>(
        'SELECT family, hash, expires_at, used FROM refresh_tokens WHERE id = ?',
        token.id,
      )
      .toArray()[0];
    if (!row || row.expires_at <= nowSeconds()) return null;
    return sameText(await sha256(token.secret), row.hash) ? row : null;
  }

  /** 新しいリフレッシュトークンを作る。コードやトークンがあるなら、人の情報も必ずある */
  private async startSession(family: string): Promise<Session> {
    const profile = this.ctx.storage.sql
      .exec<ProfileRow>('SELECT account_key, user_id, name, avatar_url FROM profile')
      .one();
    const token = { id: randomText(12), secret: randomText(32) };
    this.ctx.storage.sql.exec(
      'INSERT INTO refresh_tokens (id, family, hash, expires_at) VALUES (?, ?, ?, ?)',
      token.id,
      family,
      await sha256(token.secret),
      nowSeconds() + REFRESH_TOKEN_SECONDS,
    );
    return {
      account: { userId: profile.user_id, name: profile.name, avatarUrl: profile.avatar_url },
      accountKey: profile.account_key,
      refreshToken: token,
    };
  }

  /** 期限を過ぎたコードとトークンを消す */
  private sweep(): void {
    const now = nowSeconds();
    this.ctx.storage.sql.exec('DELETE FROM login_codes WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM refresh_tokens WHERE expires_at <= ?', now);
  }
}
