import { integer, maxLength, maxValue, minValue, nullish, number, object, picklist, pipe, string } from 'valibot';

import type { LimitKind } from '../http/backend.js';
import type { Seat } from '../rooms/host.js';
import { formatRange, inRange, parseRange } from './address.js';
import type { AddressRange } from './address.js';

/** What a ban goes by: the sender's IP address (a range of them), or the Discord account. */
export const BAN_KINDS = ['ip', 'discord'] as const;
export type BanKind = (typeof BAN_KINDS)[number];

/** The longest reason an operator can write down. */
export const MAX_BAN_REASON_LENGTH = 200;

/** The longest a ban with an end can last (in hours, ten years). Longer is written as no end. */
export const MAX_BAN_HOURS = 10 * 365 * 24;

/**
 * How long a room server goes on using the bans it read before reading them again (milliseconds),
 * for a request that only reads. What changes something, logging in and coming into a room are
 * checked against the bans as they stand.
 */
export const BAN_CACHE_MS = 30_000;

/** One ban the operator made. */
export interface Ban {
  kind: BanKind;
  /** For ip, the range (203.0.113.0/24, 2001:db8::/64). For discord, the Discord user id. */
  value: string;
  reason: string;
  /** When it was made (Unix milliseconds). */
  createdAt: number;
  /** When it ends (Unix milliseconds). Null when it does not end until it is lifted. */
  expiresAt: number | null;
}

/**
 * What the operator can stop everyone from doing for a while, in an emergency (a cost attack from
 * addresses that keep changing, say): making rooms, storing assets, and logging in anew. Those in
 * rooms and logged in already go on.
 */
export const PAUSE_KINDS = ['rooms', 'uploads', 'logins'] as const;
export type PauseKind = (typeof PAUSE_KINDS)[number];

/** What is stopped now, and since when (Unix milliseconds; null when nothing is). */
export interface Pause {
  rooms: boolean;
  uploads: boolean;
  logins: boolean;
  since: number | null;
}

export const NO_PAUSE: Pause = { rooms: false, uploads: false, logins: false, since: null };

/**
 * How many times each request counts against a rate limit the operator has tightened for now: 1 as
 * usual, and 2, 4 or 10 to let in only a half, a quarter or a tenth as many.
 */
export const TIGHTEN_WEIGHTS = [1, 2, 4, 10] as const;
export type TightenWeight = (typeof TIGHTEN_WEIGHTS)[number];

/** How tight each rate limit is now, and since when (Unix milliseconds; null when none is tightened). */
export type Tighten = Record<LimitKind, TightenWeight> & { since: number | null };

export const NO_TIGHTEN: Tighten = { upload: 1, read: 1, room: 1, auth: 1, since: null };

/** The bans, what is stopped and how tight the limits are, read together. */
export interface ModerationState {
  bans: Ban[];
  pause: Pause;
  tighten: Tighten;
}

/** The body of a request to ban. */
export const banRequestSchema = object({
  kind: picklist(BAN_KINDS),
  value: pipe(string(), maxLength(64)),
  reason: nullish(pipe(string(), maxLength(MAX_BAN_REASON_LENGTH))),
  /** How long the ban lasts. Without it, until it is lifted. */
  hours: nullish(pipe(number(), integer(), minValue(1), maxValue(MAX_BAN_HOURS))),
});

/** A Discord user id (a snowflake: a whole number written in decimal). */
const DISCORD_ID = /^\d{1,20}$/;

/** The prefix of the account key of someone who logs in with Discord. */
const DISCORD_ACCOUNT = 'discord:';

/**
 * Writes what the ban goes by the one way it is kept: a range for ip, the id for discord. Null when
 * it is not in the form for its kind.
 */
export const banValueOf = (kind: BanKind, value: string): string | null => {
  if (kind === 'discord') return DISCORD_ID.test(value.trim()) ? value.trim() : null;
  const range = parseRange(value);
  return range ? formatRange(range) : null;
};

/** The Discord user id in an account key (`discord:<ID>`). Null for an account of another kind. */
export const discordIdOf = (accountKey: string | undefined): string | null =>
  accountKey?.startsWith(DISCORD_ACCOUNT) ? accountKey.slice(DISCORD_ACCOUNT.length) : null;

const inForce = (ban: Ban, now: number) => ban.expiresAt === null || ban.expiresAt > now;

/** The bans read at one time, ready to be checked against senders and accounts, and what is stopped. */
export class BanList {
  private readonly ranges: { ban: Ban; range: AddressRange }[] = [];
  private readonly accounts = new Map<string, Ban>();

  constructor(
    bans: Ban[],
    readonly pause: Pause = NO_PAUSE,
    readonly tighten: Tighten = NO_TIGHTEN
  ) {
    for (const ban of bans) {
      if (ban.kind === 'discord') {
        this.accounts.set(`${DISCORD_ACCOUNT}${ban.value}`, ban);
        continue;
      }
      // A range kept in a form that cannot be read (written by hand) is left out.
      const range = parseRange(ban.value);
      if (range) this.ranges.push({ ban, range });
    }
  }

  /** The ban on that IP address, or null when there is none in force. */
  addressBan(address: string, now = Date.now()): Ban | null {
    return this.ranges.find(({ ban, range }) => inForce(ban, now) && inRange(range, address))?.ban ?? null;
  }

  /** The ban on that account (`discord:<ID>`), or null when there is none in force (or no account). */
  accountBan(accountKey: string | undefined, now = Date.now()): Ban | null {
    const ban = accountKey === undefined ? undefined : this.accounts.get(accountKey);
    return ban && inForce(ban, now) ? ban : null;
  }
}

/** Whether the bans cover a seat: its sender's address, or the account it came in with. */
export const barredBy =
  (list: BanList): ((seat: Seat) => boolean) =>
  (seat) =>
    (seat.address !== undefined && list.addressBan(seat.address) !== null) || list.accountBan(seat.accountKey) !== null;

/** Whether the ban covers a seat. */
export const seatBarredBy = (ban: Ban): ((seat: Seat) => boolean) => barredBy(new BanList([ban]));

/** The bans kept for a while on one instance, so that each request does not read them again. */
export interface BanCache {
  /** The bans, read again when the ones held are older than BAN_CACHE_MS. */
  current(): Promise<BanList>;
  /** The bans as they stand, read now. Those held before when they cannot be read. */
  fresh(): Promise<BanList>;
  /** Reads them again next time (after this instance changed them). */
  forget(): void;
}

/**
 * Keeps the bans load reads. When they cannot be read, the ones held before go on being used (none
 * at first) until the next try, so that a store that is down does not stop every request.
 *
 * Each request that finds them old reads them itself, rather than waiting on a read another request
 * began: a Worker may not wait on what another request is doing. What a read brings is held only
 * when no read begun after it has come back first.
 */
export const banCache = (load: () => Promise<ModerationState>, ttlMs = BAN_CACHE_MS): BanCache => {
  let held = new BanList([]);
  /** When the read that brought what is held came back (or failed), and which read it was. */
  let readAt = -Infinity;
  let heldFrom = 0;
  /** How many reads have begun, and how many had begun when the bans were last forgotten. */
  let begun = 0;
  let forgotten = 0;

  const read = async (): Promise<BanList> => {
    const number = ++begun;
    try {
      const { bans, pause, tighten } = await load();
      const list = new BanList(bans, pause, tighten);
      if (number > heldFrom) {
        held = list;
        heldFrom = number;
        readAt = Date.now();
      }
      return list;
    } catch (err) {
      console.error('Could not read the bans:', err);
      // Counted as a read, so that a store that is down is asked again only once those held grow old.
      if (number > heldFrom) {
        heldFrom = number;
        readAt = Date.now();
      }
      return held;
    }
  };

  return {
    current: async () => (heldFrom > forgotten && Date.now() - readAt < ttlMs ? held : read()),
    fresh: read,
    forget: () => {
      forgotten = begun;
    },
  };
};
