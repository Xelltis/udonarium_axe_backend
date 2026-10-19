import type { Context, MiddlewareHandler } from 'hono';

import { noteOnce } from '../moderation/activity.js';
import type { Activity } from '../moderation/activity.js';
import { discordIdOf } from '../moderation/bans.js';
import type { Ban, BanList, PauseKind } from '../moderation/bans.js';
import type { LimitKind, ServerBackend, ServerEnv } from './backend.js';
import { fail } from './errors.js';

type ServerContext = Context<ServerEnv>;

/** What a ban says when it turns someone away, for the operator's record. */
const banDetailOf = (ban: Ban) => `${ban.kind} ${ban.value}`;

/** What happened, as written down: the Discord user id goes in when there is a Discord account. */
type Happening = Omit<Activity, 'at' | 'address' | 'discordId'> & { accountKey?: string };

const activityOf = (address: string, { accountKey, ...entry }: Happening): Activity => {
  const discordId = discordIdOf(accountKey);
  return { at: Date.now(), address, ...(discordId === null ? {} : { discordId }), ...entry };
};

/** Writes down that a banned sender or account was turned away, once a minute for each. */
const noteRefused = (backend: ServerBackend, address: string, ban: Ban, accountKey?: string) => {
  if (!noteOnce(`refused|${address}|${accountKey ?? ''}`)) return;
  backend.moderation.note(activityOf(address, { kind: 'refused', accountKey, detail: banDetailOf(ban) }));
};

/** The bans read afresh for each request, so that one request reads them only once. */
const readFor = new WeakMap<Request, Promise<BanList>>();

/**
 * The bans to check the request against: as this instance read them a short while ago
 * (BAN_CACHE_MS), or with now, as they stand in the store.
 *
 * Reading the store costs a request to it, so the routes ask for the bans as they stand only where
 * letting someone through costs something (making a room, logging in, handing out tokens), and only
 * once the request has shown it is worth answering: a good token or login, within the sender's limit.
 * A flood of requests, banned or made up, then reads no more than the limits let through.
 */
const bansFor = (c: ServerContext, now: boolean): Promise<BanList> => {
  const { moderation } = c.var.backend;
  if (!now) return moderation.current();
  const read = readFor.get(c.req.raw) ?? moderation.fresh();
  readFor.set(c.req.raw, read);
  return read;
};

/**
 * The ban on the sender of the request, or null when there is none. Writes it down when there is.
 * now says whether to go by the bans as they stand (see bansFor).
 */
export const addressBanOf = async (c: ServerContext, now = false): Promise<Ban | null> => {
  const { backend } = c.var;
  const address = backend.addressOf(c.req.raw);
  const ban = (await bansFor(c, now)).addressBan(address);
  if (ban) noteRefused(backend, address, ban);
  return ban;
};

/**
 * The ban on the account (`discord:<ID>`), or null when there is none. Writes it down when there is.
 * now is as for addressBanOf.
 */
export const accountBanOf = async (
  c: ServerContext,
  accountKey: string | undefined,
  now = false
): Promise<Ban | null> => {
  const { backend } = c.var;
  const ban = (await bansFor(c, now)).accountBan(accountKey);
  if (ban) noteRefused(backend, backend.addressOf(c.req.raw), ban, accountKey);
  return ban;
};

/**
 * Whether the operator has stopped that for now, by what is stopped as it stands (read with the
 * bans, so a request that checks both reads once). Asked only where the bans are read afresh too.
 */
export const pausedNow = async (c: ServerContext, kind: PauseKind): Promise<boolean> =>
  (await bansFor(c, true)).pause[kind];

/**
 * Turns away, with 403 banned, a sender the operator has banned, by the bans this instance read a
 * short while ago: it is asked of every request, so it reads nothing.
 */
export const banGuard = (): MiddlewareHandler<ServerEnv> => async (c, next) => {
  if (await addressBanOf(c)) return fail(c, 403, 'banned');
  return next();
};

/** Writes down what happened, with the sender's address, after the response. */
export const note = (c: ServerContext, happening: Happening): void => {
  const { backend } = c.var;
  backend.moderation.note(activityOf(backend.addressOf(c.req.raw), happening));
};

/**
 * The rate limit, writing down a sender that goes over it (once a minute for each sender and limit).
 * Each room server puts it around its own count, so that the counts it keeps for reading assets are
 * written down too. A limit the operator has tightened counts each request weight times, by the
 * bans this instance read a short while ago (it reads nothing for it).
 */
export const notingLimits =
  (
    limit: (request: Request, kind: LimitKind, weight: number) => Promise<boolean>,
    { addressOf, moderation }: Pick<ServerBackend, 'addressOf' | 'moderation'>
  ) =>
  async (request: Request, kind: LimitKind): Promise<boolean> => {
    const weight = (await moderation.current()).tighten[kind];
    if (await limit(request, kind, weight)) return true;
    const address = addressOf(request);
    if (noteOnce(`limited|${address}|${kind}`)) moderation.note(activityOf(address, { kind: 'limited', detail: kind }));
    return false;
  };
