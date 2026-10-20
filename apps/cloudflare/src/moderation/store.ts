import { DurableObject } from 'cloudflare:workers';

import {
  ACTIVITY_MS,
  MAX_ACTIVITY,
  MAX_OPERATOR_ACTIVITY,
  OPERATOR_ACTIVITY_MS,
  isOperatorStep,
} from '../core/moderation/activity';
import type { Activity, ActivityKind } from '../core/moderation/activity';
import type { Passkey, PasskeyAlgorithm } from '../core/admin/webauthn';
import type { AlertKind } from '../core/moderation/alerts';
import { NO_TIGHTEN } from '../core/moderation/bans';
import type { Ban, BanKind, ModerationState, Pause, Tighten, TightenWeight } from '../core/moderation/bans';
import { MAX_REPORTS, MAX_REPORTS_PER_REPORTER, REPORTER_MS, REPORT_MS, reporterOf } from '../core/moderation/reports';
import type { Report, ReportStatus } from '../core/moderation/reports';
import type { StorageUsage } from '../core/moderation/storage';

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

/** Where what happened is kept, and how much of it. */
const LOG = { table: 'activity', ms: ACTIVITY_MS, max: MAX_ACTIVITY };
/** Where the operators' own steps are kept, apart and for longer. */
const OPERATOR_LOG = { table: 'operator_activity', ms: OPERATOR_ACTIVITY_MS, max: MAX_OPERATOR_ACTIVITY };

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
    // The sessions logged out of, until they would have run out anyway.
    sql.exec(`CREATE TABLE IF NOT EXISTS ended_sessions (
      sid TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);
    // When each kind of alert was last sent, so that every instance together sends it once in a while.
    sql.exec(`CREATE TABLE IF NOT EXISTS alerts (
      kind TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL
    )`);
    // Reports from the rooms' seats, each kept whole as JSON.
    sql.exec(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      reporter TEXT NOT NULL,
      body TEXT NOT NULL
    )`);
    // Those past their time are looked up by when, so that letting them go does not read them all,
    // and a reporter's of late by who made them.
    sql.exec('CREATE INDEX IF NOT EXISTS reports_at ON reports (at)');
    sql.exec('CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter, at)');
    // What happened, and apart from it the operators' own steps, kept longer.
    for (const table of ['activity', 'operator_activity']) {
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        address TEXT NOT NULL,
        discord_id TEXT,
        name TEXT,
        room_key TEXT,
        detail TEXT
      )`);
      sql.exec(`CREATE INDEX IF NOT EXISTS ${table}_at ON ${table} (at)`);
    }
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
    return { bans: this.bans(), pause: this.pause(), tighten: this.tighten() };
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

  /**
   * Writes one down, and lets go of those older than ACTIVITY_MS and those past the newest
   * MAX_ACTIVITY. Each is something a sender can bring about again and again, so letting go reads
   * only what it deletes: those past their time through the index on at, and those past the number
   * by id, counted back from the new one.
   */
  note(entry: Activity): void {
    const sql = this.ctx.storage.sql;
    const { table, ms, max } = isOperatorStep(entry) ? OPERATOR_LOG : LOG;
    const { id } = sql
      .exec<{ id: number }>(
        `INSERT INTO ${table} (at, kind, address, discord_id, name, room_key, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        entry.at,
        entry.kind,
        entry.address,
        entry.discordId ?? null,
        entry.name ?? null,
        entry.roomKey ?? null,
        entry.detail ?? null
      )
      .one();
    sql.exec(`DELETE FROM ${table} WHERE at < ?`, Date.now() - ms);
    sql.exec(`DELETE FROM ${table} WHERE id <= ?`, id - max);
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

  /** Remembers a session logged out of. Those past their time are let go on the way. */
  endSession(sid: string, ms: number): void {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec('DELETE FROM ended_sessions WHERE expires_at <= ?', now);
    sql.exec('INSERT OR REPLACE INTO ended_sessions (sid, expires_at) VALUES (?, ?)', sid, now + ms);
  }

  sessionEnded(sid: string): boolean {
    return (
      this.ctx.storage.sql
        .exec('SELECT 1 FROM ended_sessions WHERE sid = ? AND expires_at > ?', sid, Date.now())
        .toArray().length > 0
    );
  }

  /** How tight the rate limits are now. Kept in admin_state, one row for each limit, and when it began. */
  tighten(): Tighten {
    const rows = this.ctx.storage.sql
      .exec<{ name: string; value: number }>("SELECT name, value FROM admin_state WHERE name LIKE 'tighten_%'")
      .toArray();
    const value = (name: string) => rows.find((row) => row.name === name)?.value;
    // Nothing kept is the usual limits.
    if (value('tighten_upload') === undefined) return NO_TIGHTEN;
    return {
      upload: value('tighten_upload') as TightenWeight,
      read: value('tighten_read') as TightenWeight,
      room: value('tighten_room') as TightenWeight,
      auth: value('tighten_auth') as TightenWeight,
      since: value('tighten_since') ?? null,
    };
  }

  setTighten(tighten: Tighten): void {
    const sql = this.ctx.storage.sql;
    for (const kind of ['upload', 'read', 'room', 'auth'] as const) {
      sql.exec('INSERT OR REPLACE INTO admin_state (name, value) VALUES (?, ?)', `tighten_${kind}`, tighten[kind]);
    }
    if (tighten.since === null) sql.exec("DELETE FROM admin_state WHERE name = 'tighten_since'");
    else sql.exec("INSERT OR REPLACE INTO admin_state (name, value) VALUES ('tighten_since', ?)", tighten.since);
  }

  /**
   * Keeps a report, letting the oldest go past MAX_REPORTS or REPORT_MS, or keeps nothing (false)
   * when its reporter has made MAX_REPORTS_PER_REPORTER in the last REPORTER_MS. As for what
   * happened, letting go reads only what it deletes: by at through its index, and by rowid, which
   * grows with each report kept.
   */
  putReport(report: Report): boolean {
    const sql = this.ctx.storage.sql;
    const reporter = reporterOf(report);
    const recent = sql
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND at > ?',
        reporter,
        report.at - REPORTER_MS
      )
      .one().n;
    if (recent >= MAX_REPORTS_PER_REPORTER) return false;
    const { rowid } = sql
      .exec<{ rowid: number }>(
        'INSERT INTO reports (id, at, reporter, body) VALUES (?, ?, ?, ?) RETURNING rowid',
        report.id,
        report.at,
        reporter,
        JSON.stringify(report)
      )
      .one();
    sql.exec('DELETE FROM reports WHERE at < ?', Date.now() - REPORT_MS);
    sql.exec('DELETE FROM reports WHERE rowid <= ?', rowid - MAX_REPORTS);
    return true;
  }

  /** The reports kept, newest first. */
  reports(): Report[] {
    return this.ctx.storage.sql
      .exec<{ body: string }>('SELECT body FROM reports WHERE at >= ? ORDER BY at DESC, id', Date.now() - REPORT_MS)
      .toArray()
      .map((row) => JSON.parse(row.body) as Report);
  }

  setReportStatus(id: string, status: ReportStatus, by: string, at: number): Report | null {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ body: string }>('SELECT body FROM reports WHERE id = ?', id).toArray()[0];
    if (!row) return null;
    const report: Report = { ...(JSON.parse(row.body) as Report), status, handledAt: at, handledBy: by };
    sql.exec('UPDATE reports SET body = ? WHERE id = ?', JSON.stringify(report), id);
    return report;
  }

  /** The store's size as last counted. Kept in admin_state, as storage_bytes and the rest. */
  storageUsage(): StorageUsage | null {
    const rows = this.ctx.storage.sql
      .exec<{ name: string; value: number }>("SELECT name, value FROM admin_state WHERE name LIKE 'storage_%'")
      .toArray();
    const value = (name: string) => rows.find((row) => row.name === name)?.value;
    const at = value('storage_at');
    if (at === undefined) return null;
    // putStorageUsage writes the four together.
    return {
      bytes: value('storage_bytes') as number,
      assets: value('storage_assets') as number,
      at,
      complete: value('storage_complete') === 1,
    };
  }

  putStorageUsage(usage: StorageUsage): void {
    const sql = this.ctx.storage.sql;
    const put = (name: string, value: number) =>
      sql.exec('INSERT OR REPLACE INTO admin_state (name, value) VALUES (?, ?)', name, value);
    put('storage_bytes', usage.bytes);
    put('storage_assets', usage.assets);
    put('storage_at', usage.at);
    put('storage_complete', usage.complete ? 1 : 0);
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

  /** What is kept, the operators' own steps among the rest, newest first. */
  activity(): Activity[] {
    const read = ({ table, ms, max }: typeof LOG) =>
      this.ctx.storage.sql
        .exec<ActivityRow>(
          `SELECT at, kind, address, discord_id, name, room_key, detail FROM ${table}
           WHERE at >= ? ORDER BY id DESC LIMIT ?`,
          Date.now() - ms,
          max
        )
        .toArray()
        .map(activityOf);
    return [...read(LOG), ...read(OPERATOR_LOG)].sort((a, b) => b.at - a.at);
  }
}
