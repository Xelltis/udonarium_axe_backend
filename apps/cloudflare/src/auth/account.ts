import { DurableObject } from 'cloudflare:workers';

import { ACCOUNT_USER_ID_PREFIX } from '../../contracts/protocol';
import type { Account } from '../../contracts/protocol';
import {
  LOGIN_CODE_SECONDS,
  REFRESH_TOKEN_SECONDS,
  newLoginCode,
  newRefreshToken,
  nowSeconds,
  sameText,
  sha256,
} from '../core/auth/secrets';
import type { IssuedToken, Profile, Secret, Session } from '../core/auth/secrets';

interface ProfileRow extends Record<string, SqlStorageValue> {
  account_key: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
}

/**
 * The account of one person who logged in. Its name is the accountKey (`discord:<ID>`).
 *
 * It keeps the person's details, the one-time codes for coming back from a login, and the refresh
 * tokens. Every secret is kept as a hash, never as it is. It does not use D1, so a deploy has nothing
 * more to make.
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
   * The person logged in. Stores their details again (the user id stays the one set the first time)
   * and makes the one-time code handed to Axe. challenge is the code_challenge Axe gave when it began
   * the login.
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
      now
    );
    this.sweep();
    const code = newLoginCode();
    sql.exec(
      'INSERT INTO login_codes (id, hash, challenge, expires_at) VALUES (?, ?, ?, ?)',
      code.id,
      await sha256(code.secret),
      challenge,
      now + LOGIN_CODE_SECONDS
    );
    return code;
  }

  /**
   * Trades the code from coming back from a login for a refresh token. A code works only once.
   * verifier is the code_verifier the code_challenge was made from (the one whose SHA-256, in base64url,
   * matches challenge).
   */
  async redeem(code: Secret, verifier: string): Promise<Session | null> {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ hash: string; challenge: string; expires_at: number }>(
        'SELECT hash, challenge, expires_at FROM login_codes WHERE id = ?',
        code.id
      )
      .toArray()[0];
    if (!row) return null;
    sql.exec('DELETE FROM login_codes WHERE id = ?', code.id);
    const valid =
      row.expires_at > nowSeconds() &&
      sameText(await sha256(code.secret), row.hash) &&
      sameText(await sha256(verifier), row.challenge);
    return valid ? this.startSession(crypto.randomUUID(), await newRefreshToken()) : null;
  }

  /**
   * Uses a refresh token and trades it for a new one of the same family.
   * When one already used comes again, it is taken as stolen and its whole family is made invalid.
   *
   * The hash and the token to trade for are made first, and there is no await between finding the
   * row and writing the new token. With one there, two requests that come at once with the same token
   * could both pass as not yet used, or a new token written after the other made the family invalid
   * could live on.
   */
  async refresh(token: Secret): Promise<Session | null> {
    const sql = this.ctx.storage.sql;
    const hash = await sha256(token.secret);
    const next = await newRefreshToken();
    const row = this.findRefreshToken(token, hash);
    if (!row) return null;
    if (row.used === 1) {
      sql.exec('DELETE FROM refresh_tokens WHERE family = ?', row.family);
      return null;
    }
    sql.exec('UPDATE refresh_tokens SET used = 1 WHERE id = ?', token.id);
    return this.startSession(row.family, next);
  }

  /** The person logged out. Makes that refresh token's whole family invalid. */
  async signOut(token: Secret): Promise<void> {
    const row = this.findRefreshToken(token, await sha256(token.secret));
    if (row) this.ctx.storage.sql.exec('DELETE FROM refresh_tokens WHERE family = ?', row.family);
  }

  /** The details of the person who is logged in. Null after the account is deleted. */
  account(): Account | null {
    const row = this.ctx.storage.sql
      .exec<ProfileRow>('SELECT account_key, user_id, name, avatar_url FROM profile')
      .toArray()[0];
    return row ? { userId: row.user_id, name: row.name, avatarUrl: row.avatar_url } : null;
  }

  /**
   * Deletes the account. The person's details and every token go. userId is the person whose token
   * asked for the deletion; when it differs from the current account (one the same person made again
   * by logging in after a deletion), nothing is deleted and it returns false.
   */
  async erase(userId: string): Promise<boolean> {
    if (this.account()?.userId !== userId) return false;
    await this.ctx.storage.deleteAll();
    this.migrate();
    return true;
  }

  /** hash is the SHA-256 of token.secret (base64url). */
  private findRefreshToken(token: Secret, hash: string): { family: string; used: number } | null {
    const row = this.ctx.storage.sql
      .exec<{ family: string; hash: string; expires_at: number; used: number }>(
        'SELECT family, hash, expires_at, used FROM refresh_tokens WHERE id = ?',
        token.id
      )
      .toArray()[0];
    if (!row || row.expires_at <= nowSeconds()) return null;
    return sameText(hash, row.hash) ? row : null;
  }

  /**
   * Adds the refresh token made beforehand to the family. Where there is a code or a token, the
   * person's details are always there too.
   * There is no await between the writes.
   */
  private startSession(family: string, next: IssuedToken): Session {
    const profile = this.ctx.storage.sql
      .exec<ProfileRow>('SELECT account_key, user_id, name, avatar_url FROM profile')
      .one();
    this.ctx.storage.sql.exec(
      'INSERT INTO refresh_tokens (id, family, hash, expires_at) VALUES (?, ?, ?, ?)',
      next.token.id,
      family,
      next.hash,
      nowSeconds() + REFRESH_TOKEN_SECONDS
    );
    return {
      account: { userId: profile.user_id, name: profile.name, avatarUrl: profile.avatar_url },
      accountKey: profile.account_key,
      refreshToken: next.token,
    };
  }

  /** Deletes the codes and tokens that are past their expiry. */
  private sweep(): void {
    const now = nowSeconds();
    this.ctx.storage.sql.exec('DELETE FROM login_codes WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM refresh_tokens WHERE expires_at <= ?', now);
  }
}
