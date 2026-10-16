import type { LimitKind, ServerBackend } from './core/http/backend';
import { networkOf } from './core/http/network';
import { r2Assets } from './assets/r2';
import { LOBBY_NAME } from './rooms/lobby';

/** What is rate limited, and the binding that holds its limit (the ratelimits in wrangler.jsonc). */
const LIMITERS = {
  upload: 'UPLOAD_LIMITER',
  read: 'READ_LIMITER',
  room: 'ROOM_LIMITER',
  auth: 'AUTH_LIMITER',
} as const satisfies Record<LimitKind, keyof Env>;

/**
 * The Worker's room server. It keeps rooms, the room list and accounts in Durable Objects and a room's
 * assets in R2, and counts each sender's requests with the rate limit bindings.
 */
export const cloudflareBackend = (env: Env, waitUntil: (work: Promise<unknown>) => void): ServerBackend => {
  /**
   * Whether the count for the sender (each /64 for IPv6) is within the limit. namespace_id is shared
   * among the Workers of one account, so the key starts with the host name the request came to, and
   * the counts do not mix with those of another instance on the same account.
   */
  const limit = async (request: Request, kind: LimitKind): Promise<boolean> => {
    const network = networkOf(request.headers.get('CF-Connecting-IP') ?? 'unknown');
    const key = `${new URL(request.url).host}/${network}`;
    return (await env[LIMITERS[kind]].limit({ key })).success;
  };
  const lobby = () => env.LOBBY.getByName(LOBBY_NAME);
  const room = (roomKey: string) => env.ROOMS.getByName(roomKey);

  return {
    limit,
    lobby: {
      list: (userId) => lobby().list(userId),
      find: (roomKey, userId) => lobby().find(roomKey, userId),
    },
    rooms: {
      create: (init) => room(init.roomKey).create(init),
      remove: (roomKey, userId) => room(roomKey).deleteRoom(userId),
      canUpload: (roomKey, userId) => room(roomKey).canUpload(userId),
      connect: (request, roomKey) => room(roomKey).fetch(request),
    },
    account: (accountKey) => env.ACCOUNTS.getByName(accountKey),
    assets: r2Assets(env, waitUntil, limit),
  };
};
