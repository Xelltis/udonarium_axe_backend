import type { AdminStore } from '../admin/store.js';
import { ADMIN_DENIED, alertOf } from './alerts.js';
import type { AlertFacts, AlertKind } from './alerts.js';
import type { Report, ReportStatus } from './reports.js';
import type { StorageUsage } from './storage.js';
import { BanList } from './bans.js';
import type { Ban, BanCache, BanKind, ModerationState, Pause, Tighten } from './bans.js';

/**
 * What is written down for the operator, to find who is running up the bill.
 *
 * - login: someone logged in
 * - room: someone made a room
 * - upload: someone stored a new room asset
 * - limited: a sender went over a rate limit (once a minute for each sender and limit)
 * - refused: a banned sender or account was turned away (once a minute for each)
 * - admin: the operator banned, lifted a ban or deleted a room, or the operator's key was wrong
 */
export const ACTIVITY_KINDS = ['login', 'room', 'upload', 'limited', 'refused', 'admin'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** How many are kept. Past it, the oldest go. */
export const MAX_ACTIVITY = 2000;

/** How long one is kept (milliseconds, seven days). */
export const ACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many of the operators' own steps are kept, and for how long (milliseconds, 90 days). They are
 * kept apart from the rest, so that a flood of logins or uploads cannot push out who looked at what
 * or deleted what.
 */
export const MAX_OPERATOR_ACTIVITY = 1000;
export const OPERATOR_ACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Whether it is one of the operators' own steps (kept apart for longer). Someone turned away from
 * the dashboard is not: anyone can cause as many of those as they like.
 */
export const isOperatorStep = (entry: Activity): boolean =>
  entry.kind === 'admin' && !entry.detail?.startsWith(ADMIN_DENIED);

/** How long the same thing about the same sender is written down only once (milliseconds). */
export const NOTE_ONCE_MS = 60_000;

/** One thing that happened. */
export interface Activity {
  /** When (Unix milliseconds). */
  at: number;
  kind: ActivityKind;
  /** The sender's IP address. */
  address: string;
  /** The Discord user id, when the person was logged in. */
  discordId?: string;
  /** The name the person goes by on Discord, when known. */
  name?: string;
  roomKey?: string;
  /** What else there is to say: the room's name, the asset's type and size, the limit, the ban. */
  detail?: string;
}

/**
 * Where bans, what happened and the dashboard's passkeys are kept. Each room server keeps them in its
 * own store.
 */
export interface ModerationStore extends AdminStore {
  /** Every ban, those past their end left out. */
  bans(): Promise<Ban[]>;
  /** The bans and what is stopped, read together (what each instance keeps for a while). */
  state(): Promise<ModerationState>;
  /** Stops what is set in it, or starts it again. */
  setPause(pause: Pause): Promise<void>;
  /** Tightens the rate limits as set in it, or lets them go back. */
  setTighten(tighten: Tighten): Promise<void>;
  /** Bars an asset from being served (true), or lets it be again (false). */
  setBlocked(id: string, blocked: boolean): Promise<void>;
  /** Adds a ban, or replaces the one on the same target. */
  putBan(ban: Ban): Promise<void>;
  /** Lifts a ban. False when there was none. */
  deleteBan(kind: BanKind, value: string): Promise<boolean>;
  /**
   * Writes one down, letting the oldest go past MAX_ACTIVITY or ACTIVITY_MS (an operator's own step,
   * past MAX_OPERATOR_ACTIVITY or OPERATOR_ACTIVITY_MS, kept apart).
   */
  note(entry: Activity): Promise<void>;
  /** Those kept, the operators' own steps among them, newest first. */
  activity(): Promise<Activity[]>;
  /**
   * Whether this instance is the one to send that kind of alert now: true at most once in ms across
   * every instance.
   */
  claimAlert(kind: AlertKind, ms: number): Promise<boolean>;
  /** The store's size as last counted, or null before the first count. */
  storageUsage(): Promise<StorageUsage | null>;
  /** Keeps the store's size as just counted. */
  putStorageUsage(usage: StorageUsage): Promise<void>;
  /**
   * Keeps a report, letting the oldest go past MAX_REPORTS or REPORT_MS. False, keeping nothing, when
   * its reporter has made MAX_REPORTS_PER_REPORTER in the last REPORTER_MS.
   */
  putReport(report: Report): Promise<boolean>;
  /** The reports kept, newest first. */
  reports(): Promise<Report[]>;
  /** Sets what the operator made of a report. The report as it now stands, or null when there is none. */
  setReportStatus(id: string, status: ReportStatus, by: string, at: number): Promise<Report | null>;
}

/** What the routes use to check bans and write down what happened. */
export interface Moderation {
  /** The bans in force, as read a short while ago (see BAN_CACHE_MS). */
  current(): Promise<BanList>;
  /** The bans in force as they stand, read now (those read last when they cannot be read). */
  fresh(): Promise<BanList>;
  /** Every ban, read afresh. */
  bans(): Promise<Ban[]>;
  ban(ban: Ban): Promise<void>;
  unban(kind: BanKind, value: string): Promise<boolean>;
  /** Stops what is set in it, or starts it again. This instance reads it again at once. */
  setPause(pause: Pause): Promise<void>;
  /**
   * Bars an asset from being served (true), or lets it be again (false). This instance reads it again
   * at once; the others within BAN_CACHE_MS.
   */
  setBlocked(id: string, blocked: boolean): Promise<void>;
  /**
   * Tightens the rate limits as set in it, or lets them go back. This instance reads it again at
   * once; the others within BAN_CACHE_MS.
   */
  setTighten(tighten: Tighten): Promise<void>;
  /**
   * Writes it down after the response, and tells the operator when it calls for an alert. A failure
   * goes to the log and nowhere else.
   */
  note(entry: Activity): void;
  activity(): Promise<Activity[]>;
  /** The store's size as last counted, or null before the first count. */
  storageUsage(): Promise<StorageUsage | null>;
  putStorageUsage(usage: StorageUsage): Promise<void>;
  /** Tells the operator the store is past limitBytes (once a day at most). Nothing without alerts. */
  alertStorage(usage: StorageUsage, limitBytes: number): Promise<void>;
  /**
   * Keeps a report, and tells the operator of it after the response (when alerts are sent). False
   * when its reporter has made too many of late (see putReport).
   */
  report(report: Report): Promise<boolean>;
  reports(): Promise<Report[]>;
  setReportStatus(id: string, status: ReportStatus, by: string, at: number): Promise<Report | null>;
  /** Where the dashboard keeps passkeys and the generation of its sessions. */
  admin: AdminStore;
}

/** Puts the store and the bans kept on this instance together. alert sends alerts (none without it). */
export const moderationOf = (
  store: ModerationStore,
  cache: BanCache,
  defer: (work: Promise<unknown>) => void,
  alert?: (kind: AlertKind, facts: AlertFacts) => Promise<void>
): Moderation => ({
  current: () => cache.current(),
  fresh: () => cache.fresh(),
  bans: () => store.bans(),
  ban: async (ban) => {
    await store.putBan(ban);
    cache.forget();
  },
  unban: async (kind, value) => {
    const lifted = await store.deleteBan(kind, value);
    cache.forget();
    return lifted;
  },
  setPause: async (pause) => {
    await store.setPause(pause);
    cache.forget();
  },
  setBlocked: async (id, blocked) => {
    await store.setBlocked(id, blocked);
    cache.forget();
  },
  setTighten: async (tighten) => {
    await store.setTighten(tighten);
    cache.forget();
  },
  note: (entry) => {
    defer(store.note(entry).catch((err: unknown) => console.error('Could not write down what happened:', err)));
    const kind = alert && alertOf(entry);
    if (kind) defer(alert(kind, entry).catch((err: unknown) => console.error('Could not send the alert:', err)));
  },
  activity: () => store.activity(),
  storageUsage: () => store.storageUsage(),
  putStorageUsage: (usage) => store.putStorageUsage(usage),
  alertStorage: async (usage, limitBytes) => {
    if (alert) await alert('storage', { usage, limitBytes });
  },
  report: async (report) => {
    if (!(await store.putReport(report))) return false;
    if (alert) defer(alert('report', {}).catch((err: unknown) => console.error('Could not send the alert:', err)));
    return true;
  },
  reports: () => store.reports(),
  setReportStatus: (id, status, by, at) => store.setReportStatus(id, status, by, at),
  admin: store,
});

/** For a room server with no store (no login set up): no bans, and nothing to write down. */
export const noModeration: Moderation = {
  current: async () => new BanList([]),
  fresh: async () => new BanList([]),
  bans: async () => [],
  ban: async () => undefined,
  unban: async () => false,
  setPause: async () => undefined,
  setBlocked: async () => undefined,
  setTighten: async () => undefined,
  note: () => undefined,
  activity: async () => [],
  storageUsage: async () => null,
  putStorageUsage: async () => undefined,
  alertStorage: async () => undefined,
  report: async () => true,
  reports: async () => [],
  setReportStatus: async () => null,
  // The dashboard answers 503 without login, so it asks nothing of these.
  admin: {
    passkeysOf: async () => [],
    passkey: async () => null,
    putPasskey: async () => undefined,
    deletePasskey: async () => false,
    adminEpoch: async () => 0,
    raiseAdminEpoch: async () => 0,
    takeChallenge: async () => false,
    endSession: async () => undefined,
    sessionEnded: async () => false,
  },
};

/** When each thing was last written down, for those written only once in a while. */
const notedAt = new Map<string, number>();

/** How many are remembered before all are let go (so that many senders do not fill memory). */
const MAX_REMEMBERED = 10_000;

/**
 * Whether something that comes again and again (a sender over a limit, or turned away) is to be
 * written down now: the first time, and then once NOTE_ONCE_MS has gone by. Each instance counts on
 * its own, so it may be written down once on each.
 */
export const noteOnce = (key: string, now = Date.now()): boolean => {
  const last = notedAt.get(key);
  if (last !== undefined && now - last < NOTE_ONCE_MS) return false;
  if (notedAt.size >= MAX_REMEMBERED) notedAt.clear();
  notedAt.set(key, now);
  return true;
};
