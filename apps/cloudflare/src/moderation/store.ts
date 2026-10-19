import { DurableObject } from 'cloudflare:workers';

import { ACTIVITY_MS, MAX_ACTIVITY } from '../core/moderation/activity';
import type { Activity, ActivityKind } from '../core/moderation/activity';
import type { Passkey, PasskeyAlgorithm } from '../core/admin/webauthn';
import type { AlertKind } from '../core/moderation/alerts';
import type { Ban, BanKind, ModerationState, Pause } from '../core/moderation/bans';

/** The name of the Durable Object that keeps the bans and what happened. There is only one for each Worker. */
export const MODERATION_NAME = 'moderation';

interface BanRow extends Record<string, SqlStorageValue> {
  kind: string;
  value: string;
  reason: string;
  created_at: number;
  expires_at: number | null;
}

interface PasskeyRow extends Record<string, SqlStorageValue> {
  id: string;
  discord_id: string;
  public_key: string;
  algorithm: number;
  name: string;
  created_at: number;
  used_at: number | null;
  sign_count: number;
}

const passkeyOf = (row: PasskeyRow): Passkey => ({
  id: row.id,
  discordId: row.discord_id,
  publicKey: row.public_key,
  algorithm: row.algorithm as PasskeyAlgorithm,
  name: row.name,
  createdAt: row.created_at,
  usedAt: row.used_at,
  signCount: row.sign_count,
});

interface ActivityRow extends Record<string, SqlStorageValue> {
  at: number;
  kind: string;
  address: string;
  discord_id: string | null;
  name: string | null;
  room_key: string | null;
  detail: string | null;
}

/** Leaves out the columns that are null, as Activity leaves out what it does not have. */
const activityOf = (row: ActivityRow): Activity => ({
  at: row.at,
  kind: row.kind as ActivityKind,
  address: row.address,
  ...(row.discord_id === null ? {} : { discordId: row.discord_id }),
  ...(row.name === null ? {} : { name: row.name }),
  ...(row.room_key === null ? {} : { roomKey: row.room_key }),
  ...(row.detail === null ? {} : { detail: row.detail }),
});

/**
 * The operator's bans, and what happened that the operator may want to look into (logins, rooms
 * made, assets stored, senders over a limit or turned away). Each instance of the Worker reads the
 * bans once in a while (BAN_CACHE_MS), so this is not asked on every request.
 */
export class ModerationDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS bans (
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, value)
    )`);
    // The operators' passkeys, the generation of their sessions, and the challenges already taken.
    sql.exec(`CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      algorithm INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER,
      sign_count INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS admin_state (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS challenges (
      challenge TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);
    // When each kind of alert was last sent, so that every instance together sends it once in a while.
    sql.exec(`CREATE TABLE IF NOT EXISTS alerts (
      kind TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      address TEXT NOT NULL,
      discord_id TEXT,
      name TEXT,
      room_key TEXT,
      detail TEXT
    )`);
  }

  /** Every ban in force, newest first. Those past their end are deleted on the way. */
  bans(): Ban[] {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?', Date.now());
    return sql
      .exec<BanRow>('SELECT kind, value, reason, created_at, expires_at FROM bans ORDER BY created_at DESC, value')
      .toArray()
      .map((row) => ({
        kind: row.kind as BanKind,
        value: row.value,
        reason: row.reason,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      }));
  }

  /** The bans and what is stopped, read in one call. */
  state(): ModerationState {
    return { bans: this.bans(), pause: this.pause() };
  }

  /** What is stopped now. Kept in admin_state, one row for each kind, and when it began. */
  pause(): Pause {
    const rows = this.ctx.storage.sql
      .exec<{ name: string; value: number }>("SELECT name, value FROM admin_state WHERE name LIKE 'pause_%'")
      .toArray();
    const value = (name: string) => rows.find((row) => row.name === name)?.value;
    return {
      rooms: value('pause_rooms') === 1,
      uploads: value('pause_uploads') === 1,
      logins: value('pause_logins') === 1,
      since: value('pause_since') ?? null,
    };
  }

  setPause(pause: Pause): void {
    const sql = this.ctx.storage.sql;
    for (const kind of ['rooms', 'uploads', 'logins'] as const) {
      sql.exec('INSERT OR REPLACE INTO admin_state (name, value) VALUES (?, ?)', `pause_${kind}`, pause[kind] ? 1 : 0);
    }
    if (pause.since === null) sql.exec("DELETE FROM admin_state WHERE name = 'pause_since'");
    else sql.exec("INSERT OR REPLACE INTO admin_state (name, value) VALUES ('pause_since', ?)", pause.since);
  }

  putBan(ban: Ban): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO bans (kind, value, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      ban.kind,
      ban.value,
      ban.reason,
      ban.createdAt,
      ban.expiresAt
    );
  }

  deleteBan(kind: BanKind, value: string): boolean {
    return this.ctx.storage.sql.exec('DELETE FROM bans WHERE kind = ? AND value = ?', kind, value).rowsWritten > 0;
  }

  /** Writes one down, and lets go of those older than ACTIVITY_MS and those past the newest MAX_ACTIVITY. */
  note(entry: Activity): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO activity (at, kind, address, discord_id, name, room_key, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entry.at,
      entry.kind,
      entry.address,
      entry.discordId ?? null,
      entry.name ?? null,
      entry.roomKey ?? null,
      entry.detail ?? null
    );
    sql.exec('DELETE FROM activity WHERE at < ?', Date.now() - ACTIVITY_MS);
    sql.exec(
      'DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?)',
      MAX_ACTIVITY
    );
  }

  /** The passkeys of one operator, oldest first. */
  passkeysOf(discordId: string): Passkey[] {
    return this.ctx.storage.sql
      .exec<PasskeyRow>('SELECT * FROM passkeys WHERE discord_id = ? ORDER BY created_at, id', discordId)
      .toArray()
      .map(passkeyOf);
  }

  passkey(id: string): Passkey | null {
    const row = this.ctx.storage.sql.exec<PasskeyRow>('SELECT * FROM passkeys WHERE id = ?', id).toArray()[0];
    return row ? passkeyOf(row) : null;
  }

  putPasskey(passkey: Passkey): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO passkeys (id, discord_id, public_key, algorithm, name, created_at, used_at, sign_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      passkey.id,
      passkey.discordId,
      passkey.publicKey,
      passkey.algorithm,
      passkey.name,
      passkey.createdAt,
      passkey.usedAt,
      passkey.signCount
    );
  }

  deletePasskey(id: string): boolean {
    return this.ctx.storage.sql.exec('DELETE FROM passkeys WHERE id = ?', id).rowsWritten > 0;
  }

  adminEpoch(): number {
    return (
      this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM admin_state WHERE name = 'epoch'").toArray()[0]
        ?.value ?? 0
    );
  }

  raiseAdminEpoch(): number {
    const next = this.adminEpoch() + 1;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO admin_state (name, value) VALUES ('epoch', ?)", next);
    return next;
  }

  /** Takes a passkey challenge once. Those past their time are let go on the way. */
  takeChallenge(challenge: string, ms: number): boolean {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec('DELETE FROM challenges WHERE expires_at <= ?', now);
    return (
      sql.exec('INSERT OR IGNORE INTO challenges (challenge, expires_at) VALUES (?, ?)', challenge, now + ms)
        .rowsWritten > 0
    );
  }

  /** Whether the instance asking is the one to send that kind of alert now. True at most once in ms. */
  claimAlert(kind: AlertKind, ms: number): boolean {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const last = sql.exec<{ sent_at: number }>('SELECT sent_at FROM alerts WHERE kind = ?', kind).toArray()[0];
    if (last && now - last.sent_at < ms) return false;
    sql.exec('INSERT OR REPLACE INTO alerts (kind, sent_at) VALUES (?, ?)', kind, now);
    return true;
  }

  /** What is kept, newest first. */
  activity(): Activity[] {
    return this.ctx.storage.sql
      .exec<ActivityRow>(
        `SELECT at, kind, address, discord_id, name, room_key, detail FROM activity
         WHERE at >= ? ORDER BY id DESC LIMIT ?`,
        Date.now() - ACTIVITY_MS,
        MAX_ACTIVITY
      )
      .toArray()
      .map(activityOf);
  }
}
