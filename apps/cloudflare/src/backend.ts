import type { LimitKind, ServerBackend } from './core/http/backend';
import { notingLimits } from './core/http/moderation';
import { networkOf } from './core/http/network';
import { moderationOf } from './core/moderation/activity';
import { webhookAlerts } from './core/moderation/alerts';
import type { ModerationStore } from './core/moderation/activity';
import { banCache } from './core/moderation/bans';
import type { BanCache } from './core/moderation/bans';
import { r2Assets } from './assets/r2';
import { MODERATION_NAME } from './moderation/store';
import { LOBBY_NAME } from './rooms/lobby';

/** What is rate limited, and the binding that holds its limit (the ratelimits in wrangler.jsonc). */
const LIMITERS = {
  upload: 'UPLOAD_LIMITER',
  read: 'READ_LIMITER',
  room: 'ROOM_LIMITER',
  auth: 'AUTH_LIMITER',
} as const satisfies Record<LimitKind, keyof Env>;

/** The sender's IP address, which Cloudflare sets itself (a client cannot fake it). */
const addressOf = (request: Request): string => request.headers.get('CF-Connecting-IP') ?? 'unknown';

/**
 * The bans, kept for a while in this isolate so that each request does not ask the Durable Object.
 * Made with the first request's bindings, which are the same for every request; the Durable Object
 * is asked through a stub made in the request that reads.
 */
let bans: BanCache | null = null;

/**
 * The alerts for each webhook, made once in this isolate as the bans are, so that how often it asks
 * the store whether to send one is counted across requests.
 */
const alerts = new Map<string, ReturnType<typeof webhookAlerts>>();

const alertsOf = (env: Env) => {
  const url = env.ADMIN_WEBHOOK_URL;
  if (!url) return undefined;
  const made =
    alerts.get(url) ?? webhookAlerts(url, (kind, ms) => env.MODERATION.getByName(MODERATION_NAME).claimAlert(kind, ms));
  alerts.set(url, made);
  return made;
};

/**
 * The Worker's room server. It keeps rooms, the room list, accounts and the operator's bans in
 * Durable Objects and a room's assets in R2, and counts each sender's requests with the rate limit
 * bindings.
 */
export const cloudflareBackend = (env: Env, waitUntil: (work: Promise<unknown>) => void): ServerBackend => {
  const store: ModerationStore = env.MODERATION.getByName(MODERATION_NAME);
  bans ??= banCache(() => env.MODERATION.getByName(MODERATION_NAME).state());
  // The settings have been checked before the backend is made, so a webhook here is an https:// URL.
  const moderation = moderationOf(store, bans, waitUntil, alertsOf(env));

  /**
   * Whether the count for the sender (each /64 for IPv6) is within the limit. namespace_id is shared
   * among the Workers of one account, so the key starts with the host name the request came to, and
   * the counts do not mix with those of another instance on the same account.
   */
  const limit = notingLimits(
    async (request: Request, kind: LimitKind, weight: number): Promise<boolean> => {
      const key = `${new URL(request.url).host}/${networkOf(addressOf(request))}`;
      // A tightened limit: the request takes weight of the sender's count. The binding takes one a call.
      for (let taken = 0; taken < weight; taken++) {
        if (!(await env[LIMITERS[kind]].limit({ key })).success) return false;
      }
      return true;
    },
    { addressOf, moderation }
  );
  const lobby = () => env.LOBBY.getByName(LOBBY_NAME);
  const room = (roomKey: string) => env.ROOMS.getByName(roomKey);

  return {
    addressOf,
    limit,
    lobby: {
      list: (userId) => lobby().list(userId),
      find: (roomKey, userId) => lobby().find(roomKey, userId),
      all: () => lobby().all(),
      occupied: () => lobby().occupied(),
    },
    rooms: {
      create: (init) => room(init.roomKey).create(init),
      remove: (roomKey, userId) => room(roomKey).deleteRoom(userId),
      canUpload: (roomKey, userId) => room(roomKey).canUpload(userId),
      canDiscard: (roomKey, userId, assetId) => room(roomKey).canDiscard(userId, assetId),
      connect: (request, roomKey) => room(roomKey).fetch(request),
      seats: (roomKey) => room(roomKey).seats(),
      expel: async (roomKey, ban) => {
        await room(roomKey).expel(ban);
      },
    },
    account: (accountKey) => env.ACCOUNTS.getByName(accountKey),
    assets: r2Assets(env, waitUntil, limit),
    moderation,
  };
};
