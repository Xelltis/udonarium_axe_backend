import {
  ACTIVITY_MS,
  MAX_ACTIVITY,
  MAX_OPERATOR_ACTIVITY,
  OPERATOR_ACTIVITY_MS,
  isOperatorStep,
} from '../core/moderation/activity.js';
import type { Activity, ModerationStore } from '../core/moderation/activity.js';
import type { Passkey } from '../core/admin/webauthn.js';
import { NO_TIGHTEN } from '../core/moderation/bans.js';
import type { Ban, BanKind, Pause, Tighten, TightenWeight } from '../core/moderation/bans.js';
import {
  ANONYMOUS_RANK,
  MAX_REPORTS,
  MAX_REPORTS_PER_REPORTER,
  REPORTER_MS,
  REPORT_MS,
  rankOf,
  reporterOf,
} from '../core/moderation/reports.js';
import type { Report } from '../core/moderation/reports.js';
import type { StorageUsage } from '../core/moderation/storage.js';
import type { KeyOf, Redis } from './redis.js';

// Keeps the operator's bans and what happened in Redis. Does the same as the Cloudflare version's
// ModerationDurableObject.
//
//   mod:bans          HASH    "<kind>:<value>" → JSON of the ban.
//   mod:activity      ZSET    JSON of [a random id, what happened] → when it happened (milliseconds).
//                             The random id keeps two alike in the same millisecond apart. Kept to the
//                             newest MAX_ACTIVITY and to ACTIVITY_MS, and the whole set goes
//                             ACTIVITY_MS after the last write.
//   mod:operator-activity ZSET  The same for the operators' own steps, kept apart: the newest
//                             MAX_OPERATOR_ACTIVITY, for OPERATOR_ACTIVITY_MS.
//   mod:alert:<kind>  STRING  There while that kind of alert may not be sent again (for ALERT_MS).
//   mod:passkeys      HASH    credential id → JSON of an operator's passkey.
//   mod:admin-epoch   STRING  The generation of the operators' sessions (raised to end them all).
//   mod:challenge:<c> STRING  There once a passkey challenge has been answered, until it runs out.
//   mod:ended:<sid>   STRING  There once an operator has logged out of that session, until it would
//                             have run out anyway.
//   mod:pause         HASH    What the operator has stopped for now: rooms, uploads, logins ("1"), and since.
//   mod:storage       STRING  JSON of the store's size as last counted (once a day, by the sweep).
//   mod:tighten       HASH    How tight each rate limit is: upload, read, room, auth (1, 2, 4 or 10), and since.
//   mod:blocked       SET     The assets the operator barred from the dashboard, held with the bans.
//   mod:reports       HASH    report id → JSON of a report from a room's seat. Kept to the newest
//                             MAX_REPORTS and to REPORT_MS.
//   mod:reports:at    ZSET    The report ids by when they were made, so that the oldest go without
//                             reading every report.
//   mod:reporter:<r>  ZSET    The ids of the reports one reporter (reporterOf) made in the last
//                             REPORTER_MS, by when. It goes away REPORTER_MS after the last.
//   mod:rank:<g>      ZSET    The ids of the reports one rank (rankOf) has kept, by when. It goes
//                             away REPORT_MS after the last.
//   mod:reporters     ZSET    The ranks of accounts, highest first: the one that has kept the most
//                             (of those, the one with the oldest). Past MAX_REPORTS, the oldest of the
//                             highest goes, from whichever side holds over half.
//   mod:reporters:anonymous
//                     ZSET    The same, of senders not logged in.
//   mod:reports:anonymous
//                     STRING  How many reports of senders not logged in are kept.

const fieldOf = (kind: BanKind, value: string) => `${kind}:${value}`;

/** The time a reporter's oldest report is counted from in its place among the reporters (2025-01-01). */
const RANK_EPOCH_MS = Date.UTC(2025, 0, 1);
/** Room in a reporter's score for when its oldest report was made (milliseconds, about 31 years). */
const RANK_SPAN_MS = 1e12;

/** The store for the operator in Redis. maxReports is how many reports are kept (fewer in tests). */
export const redisModeration = (redis: Redis, key: KeyOf, maxReports = MAX_REPORTS): ModerationStore => {
  const BANS = key('mod', 'bans');
  const LOG = { key: key('mod', 'activity'), ms: ACTIVITY_MS, max: MAX_ACTIVITY };
  const OPERATOR_LOG = { key: key('mod', 'operator-activity'), ms: OPERATOR_ACTIVITY_MS, max: MAX_OPERATOR_ACTIVITY };
  const PASSKEYS = key('mod', 'passkeys');
  const EPOCH = key('mod', 'admin-epoch');
  const PAUSE = key('mod', 'pause');
  const STORAGE = key('mod', 'storage');
  const TIGHTEN = key('mod', 'tighten');
  const REPORTS = key('mod', 'reports');
  const BLOCKED = key('mod', 'blocked');
  const REPORTS_AT = key('mod', 'reports', 'at');

  /** Every report kept, newest first. Those too old are left out, and let go when the next is kept. */
  const reports = async (): Promise<Report[]> => {
    const oldest = Date.now() - REPORT_MS;
    return Object.values(await redis.hGetAll(REPORTS))
      .map((value) => JSON.parse(value) as Report)
      .filter((report) => report.at >= oldest)
      .sort((a, b) => b.at - a.at || Number(a.id > b.id) - Number(a.id < b.id));
  };

  const ACCOUNT_REPORTERS = key('mod', 'reporters');
  const ANONYMOUS_REPORTERS = key('mod', 'reporters', 'anonymous');
  const ANONYMOUS_KEPT = key('mod', 'reports', 'anonymous');
  const reporterKeyOf = (reporter: string) => key('mod', 'reporter', reporter);
  const rankKeyOf = (rank: string) => key('mod', 'rank', rank);

  /**
   * Puts a rank in its place among those of its side (senders not logged in, or accounts): by how
   * many it has kept, then by how old its oldest is. Both fit in one score that a double holds exactly
   * (up to 2^53).
   */
  const rankReporter = async (rank: string): Promise<void> => {
    const side = rank.startsWith(ANONYMOUS_RANK) ? ANONYMOUS_REPORTERS : ACCOUNT_REPORTERS;
    const [oldest] = await redis.zRangeWithScores(rankKeyOf(rank), 0, 0);
    if (!oldest) {
      await redis.zRem(side, rank);
      return;
    }
    const kept = await redis.zCard(rankKeyOf(rank));
    const age = RANK_SPAN_MS - Math.min(Math.max(oldest.score - RANK_EPOCH_MS, 0), RANK_SPAN_MS - 1);
    await redis.zAdd(side, { score: kept * RANK_SPAN_MS + age, value: rank });
  };

  /** Lets reports go, from wherever they are kept. */
  const dropReports = async (ids: string[]): Promise<void> => {
    const values = await redis.hmGet(REPORTS, ids);
    const ranks = new Set<string>();
    for (const [at, value] of values.entries()) {
      // A report already gone (let go at the same moment by another instance) is nobody's.
      if (value === null) continue;
      const rank = rankOf(JSON.parse(value) as Report);
      ranks.add(rank);
      await redis.zRem(rankKeyOf(rank), ids[at] as string);
      if (rank.startsWith(ANONYMOUS_RANK)) await redis.decr(ANONYMOUS_KEPT);
    }
    await redis.zRem(REPORTS_AT, ids);
    await redis.hDel(REPORTS, ids);
    for (const rank of ranks) await rankReporter(rank);
  };

  /**
   * Lets go of the reports made before oldest, and past MAX_REPORTS, of the oldest of the rank that
   * has kept the most on whichever side holds over half, so that a flood from many senders pushes out
   * its own reports rather than those of others.
   */
  const trimReports = async (oldest: number): Promise<void> => {
    const old = await redis.zRangeByScore(REPORTS_AT, '-inf', `(${oldest}`);
    if (old.length > 0) await dropReports(old);
    if ((await redis.zCard(REPORTS_AT)) <= maxReports) return;
    // It goes from whichever side holds over half, senders not logged in or accounts (past
    // MAX_REPORTS one always does), so that neither can push out every report of the other.
    const anonymous = Number((await redis.get(ANONYMOUS_KEPT)) ?? 0);
    const from = anonymous > maxReports / 2 ? ANONYMOUS_REPORTERS : ACCOUNT_REPORTERS;
    const [busiest] = await redis.zRange(from, 0, 0, { REV: true });
    await dropReports(await redis.zRange(rankKeyOf(busiest as string), 0, 0));
  };

  /** Every ban in force, newest first. Those past their end are deleted on the way. */
  const bans = async (): Promise<Ban[]> => {
    const now = Date.now();
    const kept = Object.values(await redis.hGetAll(BANS)).map((value) => JSON.parse(value) as Ban);
    const ended = kept.filter((ban) => ban.expiresAt !== null && ban.expiresAt <= now);
    const endedFields = ended.map((ban) => fieldOf(ban.kind, ban.value));
    if (endedFields.length > 0) await redis.hDel(BANS, endedFields);
    return kept
      .filter((ban) => !ended.includes(ban))
      .sort((a, b) => b.createdAt - a.createdAt || Number(a.value > b.value) - Number(a.value < b.value));
  };

  const pause = async (): Promise<Pause> => {
    const kept = await redis.hGetAll(PAUSE);
    return {
      rooms: kept.rooms === '1',
      uploads: kept.uploads === '1',
      logins: kept.logins === '1',
      since: kept.since ? Number(kept.since) : null,
    };
  };

  const tighten = async (): Promise<Tighten> => {
    const kept = await redis.hGetAll(TIGHTEN);
    // Nothing kept is the usual limits.
    if (!kept.upload) return NO_TIGHTEN;
    const weight = (kind: 'upload' | 'read' | 'room' | 'auth') => Number(kept[kind]) as TightenWeight;
    return {
      upload: weight('upload'),
      read: weight('read'),
      room: weight('room'),
      auth: weight('auth'),
      since: kept.since ? Number(kept.since) : null,
    };
  };

  return {
    bans,

    async state() {
      const [kept, stopped, tight, blocked] = await Promise.all([bans(), pause(), tighten(), redis.sMembers(BLOCKED)]);
      return { bans: kept, pause: stopped, tighten: tight, blocked };
    },

    async setBlocked(id, blocked) {
      if (blocked) await redis.sAdd(BLOCKED, id);
      else await redis.sRem(BLOCKED, id);
    },

    async setTighten({ since, ...weights }) {
      await redis
        .multi()
        .del(TIGHTEN)
        .hSet(TIGHTEN, {
          upload: String(weights.upload),
          read: String(weights.read),
          room: String(weights.room),
          auth: String(weights.auth),
          ...(since === null ? {} : { since: String(since) }),
        })
        .exec();
    },

    async setPause({ rooms, uploads, logins, since }) {
      const flag = (on: boolean) => (on ? '1' : '0');
      await redis
        .multi()
        .del(PAUSE)
        .hSet(PAUSE, {
          rooms: flag(rooms),
          uploads: flag(uploads),
          logins: flag(logins),
          ...(since === null ? {} : { since: String(since) }),
        })
        .exec();
    },

    async putBan(ban) {
      await redis.hSet(BANS, fieldOf(ban.kind, ban.value), JSON.stringify(ban));
    },

    async deleteBan(kind, value) {
      return (await redis.hDel(BANS, fieldOf(kind, value))) > 0;
    },

    async note(entry) {
      const log = isOperatorStep(entry) ? OPERATOR_LOG : LOG;
      await redis
        .multi()
        .zAdd(log.key, { score: entry.at, value: JSON.stringify([crypto.randomUUID(), entry]) })
        .zRemRangeByScore(log.key, '-inf', `(${Date.now() - log.ms}`)
        .zRemRangeByRank(log.key, 0, -(log.max + 1))
        .pExpire(log.key, log.ms)
        .exec();
    },

    /** Whether the instance asking is the one to send that kind of alert now. True at most once in ms. */
    async claimAlert(kind, ms) {
      const taken = await redis.set(key('mod', 'alert', kind), String(Date.now()), {
        condition: 'NX',
        expiration: { type: 'PX', value: ms },
      });
      return taken !== null;
    },

    /** What is kept, the operators' own steps among the rest, newest first. */
    async activity() {
      const read = async (log: typeof LOG) =>
        (
          await redis.zRange(log.key, '+inf', Date.now() - log.ms, {
            BY: 'SCORE',
            REV: true,
            LIMIT: { offset: 0, count: log.max },
          })
        ).map((value) => (JSON.parse(value) as [string, Activity])[1]);
      const [rest, operators] = await Promise.all([read(LOG), read(OPERATOR_LOG)]);
      return [...rest, ...operators].sort((a, b) => b.at - a.at);
    },

    /** The passkeys of one operator, oldest first. An operator has only a few, so all are read. */
    async passkeysOf(discordId) {
      return Object.values(await redis.hGetAll(PASSKEYS))
        .map((value) => JSON.parse(value) as Passkey)
        .filter((passkey) => passkey.discordId === discordId)
        .sort((a, b) => a.createdAt - b.createdAt || Number(a.id > b.id) - Number(a.id < b.id));
    },

    async passkey(id) {
      const value = await redis.hGet(PASSKEYS, id);
      return value === null ? null : (JSON.parse(value) as Passkey);
    },

    async putPasskey(passkey) {
      await redis.hSet(PASSKEYS, passkey.id, JSON.stringify(passkey));
    },

    async deletePasskey(id) {
      return (await redis.hDel(PASSKEYS, id)) > 0;
    },

    async adminEpoch() {
      return Number((await redis.get(EPOCH)) ?? 0);
    },

    async raiseAdminEpoch() {
      return redis.incr(EPOCH);
    },

    async putReport(report) {
      // How many its reporter made of late, as counted before this one. Two at the same moment may
      // both get in; the cap is to keep one sender from crowding out the rest, not an exact count.
      const made = reporterKeyOf(reporterOf(report));
      await redis.zRemRangeByScore(made, '-inf', report.at - REPORTER_MS);
      if ((await redis.zCard(made)) >= MAX_REPORTS_PER_REPORTER) return false;
      await redis.zAdd(made, { score: report.at, value: report.id });
      await redis.pExpire(made, REPORTER_MS);
      const rank = rankOf(report);
      await redis.hSet(REPORTS, report.id, JSON.stringify(report));
      await redis.zAdd(REPORTS_AT, { score: report.at, value: report.id });
      await redis.zAdd(rankKeyOf(rank), { score: report.at, value: report.id });
      await redis.pExpire(rankKeyOf(rank), REPORT_MS);
      if (rank.startsWith(ANONYMOUS_RANK)) await redis.incr(ANONYMOUS_KEPT);
      await rankReporter(rank);
      await trimReports(Date.now() - REPORT_MS);
      return true;
    },

    reports,

    async setReportStatus(id, status, by, at) {
      const value = await redis.hGet(REPORTS, id);
      if (value === null) return null;
      const report: Report = { ...(JSON.parse(value) as Report), status, handledAt: at, handledBy: by };
      await redis.hSet(REPORTS, id, JSON.stringify(report));
      return report;
    },

    async storageUsage() {
      const value = await redis.get(STORAGE);
      return value === null ? null : (JSON.parse(value) as StorageUsage);
    },

    async putStorageUsage(usage) {
      await redis.set(STORAGE, JSON.stringify(usage));
    },

    /** Takes a passkey challenge once: only the first SET NX gets it. */
    async takeChallenge(challenge, ms) {
      const taken = await redis.set(key('mod', 'challenge', challenge), '1', {
        condition: 'NX',
        expiration: { type: 'PX', value: ms },
      });
      return taken !== null;
    },

    async endSession(sid, ms) {
      await redis.set(key('mod', 'ended', sid), '1', { expiration: { type: 'PX', value: ms } });
    },

    async sessionEnded(sid) {
      return (await redis.exists(key('mod', 'ended', sid))) > 0;
    },
  };
};
