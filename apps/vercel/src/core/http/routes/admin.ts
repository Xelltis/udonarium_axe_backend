import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { picklist, safeParse } from 'valibot';

import type { PeerRole, RoomAsset } from '../../../../contracts/protocol.js';
import { adminPage, adminPagePolicy } from '../../admin/page.js';
import { randomText } from '../../auth/secrets.js';
import type { Activity } from '../../moderation/activity.js';
import { BAN_KINDS, banRequestSchema, banValueOf, discordIdOf } from '../../moderation/bans.js';
import type { Ban } from '../../moderation/bans.js';
import type { Seat } from '../../rooms/host.js';
import { fromDashboard, logOut, passkeyRequired, recentPasskeyRequired, sessionRequired } from '../admin-session.js';
import type { AdminRoom, ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { adminLoginRoutes, adminPasskeyRoutes, adminSecurityRoutes, noteAdmin } from './admin-auth.js';
import { adminToolRoutes } from './admin-tools.js';
import { ROOM_KEY } from './rooms.js';

// The operator's dashboard (/admin) and what it calls (/admin/api). It is there only when
// ADMIN_DISCORD_IDS is set. An operator gets in through Discord and then a passkey (admin-auth.ts),
// and every call to the API needs the session that leaves (admin-session.ts). It is not behind the
// bans, so that an operator who bans their own address can still lift it.

const HOUR_MS = 60 * 60 * 1000;

/** Someone in a room, as the operator sees them. */
export interface AdminSeat {
  peerId: string;
  userId: string;
  role: PeerRole;
  account: boolean;
  discordId: string | null;
  /** Null when the room server was not told it (a seat that came in before this was kept). */
  address: string | null;
  joinedAt: number;
}

/** A room as the dashboard gets it: the Discord user id in place of the account. */
export type AdminRoomView = Omit<AdminRoom, 'creator'> & {
  creator: { discordId: string | null; address: string } | null;
};

export interface AdminRoomsResponse {
  rooms: AdminRoomView[];
}
export interface AdminSeatsResponse {
  seats: AdminSeat[];
}
export interface AdminBansResponse {
  bans: Ban[];
}
export interface AdminBanResponse {
  ban: Ban;
}
export interface AdminActivityResponse {
  activity: Activity[];
}
export interface AdminAssetsResponse {
  assets: RoomAsset[];
}

const seatOf = (seat: Seat): AdminSeat => ({
  peerId: seat.peerId,
  userId: seat.userId,
  role: seat.role,
  account: seat.account,
  discordId: discordIdOf(seat.accountKey),
  address: seat.address ?? null,
  joinedAt: seat.joinedAt,
});

const roomOf = ({ creator, ...room }: AdminRoom): AdminRoomView => ({
  ...room,
  creator: creator && { discordId: discordIdOf(creator.accountKey), address: creator.address },
});

/** Nothing of the dashboard is kept by the browser or a cache on the way, or shown in another page's frame. */
const privately: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (!c.var.config.admin) return fail(c, 404, 'not-found');
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
};

/** With no login set up there are no rooms, nowhere to keep bans, and no Discord to log in with. */
const loginAvailable: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (!c.var.config.login) return fail(c, 503, 'login-unavailable');
  return next();
};

/** The room key in the path, or null when it is not in the form of one. */
const roomKeyOf = (value: string): string | null => (ROOM_KEY.test(value) ? value : null);

export const adminRoutes = (): Hono<ServerEnv> => {
  const admin = new Hono<ServerEnv>();
  admin.use('*', privately);

  admin.get('/', (c) => {
    const nonce = randomText(16);
    c.header('Content-Security-Policy', adminPagePolicy(nonce));
    return c.html(adminPage(nonce));
  });

  adminLoginRoutes(admin);

  admin.use('/api/*', fromDashboard, loginAvailable);
  /** Ends this session. It needs none that is still good, so that a page left open can always leave. */
  admin.post('/api/logout', async (c) => {
    await logOut(c);
    return c.body(null, 204);
  });
  admin.use('/api/*', sessionRequired);
  adminPasskeyRoutes(admin);
  // Everything after this needs a session a passkey has confirmed.
  admin.use('/api/*', passkeyRequired);
  adminSecurityRoutes(admin);

  admin.get('/api/rooms', async (c) =>
    c.json<AdminRoomsResponse>({ rooms: (await c.var.backend.lobby.all()).map(roomOf) })
  );

  admin.get('/api/rooms/:roomKey/seats', async (c) => {
    const roomKey = roomKeyOf(c.req.param('roomKey'));
    if (!roomKey) return fail(c, 400, 'invalid-id');
    return c.json<AdminSeatsResponse>({ seats: (await c.var.backend.rooms.seats(roomKey)).map(seatOf) });
  });

  /** The images and sounds kept in a room, to see what takes up the store. None for a room that is not there. */
  admin.get('/api/rooms/:roomKey/assets', async (c) => {
    const roomKey = roomKeyOf(c.req.param('roomKey'));
    if (!roomKey) return fail(c, 400, 'invalid-id');
    return c.json<AdminAssetsResponse>({ assets: await c.var.backend.assets.list(roomKey) });
  });

  /**
   * Deletes a room, whoever its GM is. Those in it are closed with room-deleted. It cannot be undone,
   * so it asks for a passkey that confirmed the session recently.
   */
  admin.delete('/api/rooms/:roomKey', recentPasskeyRequired, async (c) => {
    const roomKey = roomKeyOf(c.req.param('roomKey'));
    if (!roomKey) return fail(c, 400, 'invalid-id');
    if ((await c.var.backend.rooms.remove(roomKey, null)) !== 'deleted') return fail(c, 404, 'room-not-found');
    noteAdmin(c, 'delete room', { roomKey });
    return c.body(null, 204);
  });

  admin.get('/api/bans', async (c) => c.json<AdminBansResponse>({ bans: await c.var.backend.moderation.bans() }));

  /**
   * Bans a sender (a range of IP addresses) or a Discord account. Those already in a room whom it
   * covers are closed too. It applies at once on every instance to what changes something, logging
   * in and coming into a room; requests that only read go by it within BAN_CACHE_MS.
   */
  admin.post('/api/bans', async (c) => {
    const { backend } = c.var;
    const parsed = safeParse(banRequestSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const { kind, reason, hours } = parsed.output;
    const value = banValueOf(kind, parsed.output.value);
    if (value === null) return fail(c, 400, 'invalid-request');
    const now = Date.now();
    const ban: Ban = {
      kind,
      value,
      reason: reason ?? '',
      createdAt: now,
      expiresAt: hours ? now + hours * HOUR_MS : null,
    };
    await backend.moderation.ban(ban);
    noteAdmin(c, `ban ${kind} ${value}`);
    const closing = (await backend.lobby.occupied()).map((roomKey) => backend.rooms.expel(roomKey, ban));
    for (const result of await Promise.allSettled(closing)) {
      if (result.status === 'rejected') console.error('Could not close the banned seats in a room:', result.reason);
    }
    return c.json<AdminBanResponse>({ ban }, 201);
  });

  /** Lifts a ban. kind and value go in the query (value as the dashboard shows it). */
  admin.delete('/api/bans', async (c) => {
    const kind = safeParse(picklist(BAN_KINDS), c.req.query('kind'));
    const value = c.req.query('value');
    if (!kind.success || !value) return fail(c, 400, 'invalid-request');
    if (!(await c.var.backend.moderation.unban(kind.output, value))) return fail(c, 404, 'not-found');
    noteAdmin(c, `unban ${kind.output} ${value}`);
    return c.body(null, 204);
  });

  admin.get('/api/activity', async (c) =>
    c.json<AdminActivityResponse>({ activity: await c.var.backend.moderation.activity() })
  );

  adminToolRoutes(admin);

  return admin;
};
