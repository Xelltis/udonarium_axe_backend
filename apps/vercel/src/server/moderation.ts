import { ACTIVITY_MS, MAX_ACTIVITY } from '../core/moderation/activity.js';
import type { Activity, ModerationStore } from '../core/moderation/activity.js';
import type { Passkey } from '../core/admin/webauthn.js';
import type { Ban, BanKind, Pause } from '../core/moderation/bans.js';
import type { KeyOf, Redis } from './redis.js';

// Keeps the operator's bans and what happened in Redis. Does the same as the Cloudflare version's
// ModerationDurableObject.
//
//   mod:bans          HASH    "<kind>:<value>" → JSON of the ban.
//   mod:activity      ZSET    JSON of [a random id, what happened] → when it happened (milliseconds).
//                             The random id keeps two alike in the same millisecond apart. Kept to the
//                             newest MAX_ACTIVITY and to ACTIVITY_MS, and the whole set goes
//                             ACTIVITY_MS after the last write.
//   mod:alert:<kind>  STRING  There while that kind of alert may not be sent again (for ALERT_MS).
//   mod:passkeys      HASH    credential id → JSON of an operator's passkey.
//   mod:admin-epoch   STRING  The generation of the operators' sessions (raised to end them all).
//   mod:challenge:<c> STRING  There once a passkey challenge has been answered, until it runs out.
//   mod:pause         HASH    What the operator has stopped for now: rooms, uploads, logins ("1"), and since.

const fieldOf = (kind: BanKind, value: string) => `${kind}:${value}`;

export const redisModeration = (redis: Redis, key: KeyOf): ModerationStore => {
  const BANS = key('mod', 'bans');
  const ACTIVITY = key('mod', 'activity');
  const PASSKEYS = key('mod', 'passkeys');
  const EPOCH = key('mod', 'admin-epoch');
  const PAUSE = key('mod', 'pause');

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

  return {
    bans,

    async state() {
      const [kept, stopped] = await Promise.all([bans(), pause()]);
      return { bans: kept, pause: stopped };
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
      await redis
        .multi()
        .zAdd(ACTIVITY, { score: entry.at, value: JSON.stringify([crypto.randomUUID(), entry]) })
        .zRemRangeByScore(ACTIVITY, '-inf', `(${Date.now() - ACTIVITY_MS}`)
        .zRemRangeByRank(ACTIVITY, 0, -(MAX_ACTIVITY + 1))
        .pExpire(ACTIVITY, ACTIVITY_MS)
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

    /** What is kept, newest first. */
    async activity() {
      const kept = await redis.zRange(ACTIVITY, '+inf', Date.now() - ACTIVITY_MS, {
        BY: 'SCORE',
        REV: true,
        LIMIT: { offset: 0, count: MAX_ACTIVITY },
      });
      return kept.map((value) => (JSON.parse(value) as [string, Activity])[1]);
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

    /** Takes a passkey challenge once: only the first SET NX gets it. */
    async takeChallenge(challenge, ms) {
      const taken = await redis.set(key('mod', 'challenge', challenge), '1', {
        condition: 'NX',
        expiration: { type: 'PX', value: ms },
      });
      return taken !== null;
    },
  };
};
