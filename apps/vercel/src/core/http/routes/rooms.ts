import { Hono } from 'hono';
import { maxLength, minLength, nullish, object, pipe, safeParse, string } from 'valibot';

import { MAX_PASSWORD_LENGTH, MAX_ROOM_NAME_LENGTH } from '../../../../contracts/protocol.js';
import type { CreateRoomResponse, RoomListResponse, RoomResponse } from '../../../../contracts/protocol.js';
import type { ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { accountBanOf, addressBanOf, note, pausedNow } from '../moderation.js';
import { bearerOf } from '../request.js';
import {
  completeUpload,
  deleteRoomAsset,
  getRoomAsset,
  listRoomAssets,
  putRoomAsset,
  requestUpload,
} from './assets.js';
import { postReport } from './reports.js';

/** A room's key: a 128-bit random number written in lowercase hex. */
export const ROOM_KEY = /^[0-9a-f]{32}$/;

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const createSchema = object({
  name: pipe(string(), minLength(1), maxLength(MAX_ROOM_NAME_LENGTH)),
  password: nullish(pipe(string(), maxLength(MAX_PASSWORD_LENGTH))),
});

const randomRoomKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Three characters for display. A clash does no harm (rooms are told apart by their keys). */
const randomRoomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) => BASE62[byte % 62]).join('');

export const roomRoutes = new Hono<ServerEnv>();

/**
 * The room list. When the request carries an access token, deletable is added to the rooms where
 * that person is GM.
 * The room server has only one list, so each sender may ask for it only so many times.
 */
roomRoutes.get('/', async (c) => {
  const { backend, config } = c.var;
  if (!(await backend.limit(c.req.raw, 'read'))) return fail(c, 429, 'rate-limited');
  const claims = config.login ? bearerOf(c, config.login) : null;
  const rooms = await backend.lobby.list(claims?.uid);
  return c.json<RoomListResponse>({ rooms });
});

/**
 * Looks up one room by its key. The list holds only the newest 1000 rooms, so this lets an invite
 * link or a reconnect find a room older than those. It is counted the same way as the list.
 */
roomRoutes.get('/:roomKey', async (c) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey');
  if (!ROOM_KEY.test(roomKey)) return fail(c, 400, 'invalid-id');
  if (!(await backend.limit(c.req.raw, 'read'))) return fail(c, 429, 'rate-limited');
  const claims = config.login ? bearerOf(c, config.login) : null;
  const room = await backend.lobby.find(roomKey, claims?.uid);
  if (!room) return fail(c, 404, 'room-not-found');
  return c.json<RoomResponse>({ room });
});

/**
 * Makes a room. Only someone logged in can make one, and whoever makes it becomes GM. 503 when no
 * login is set up. A sender or account the operator banned cannot make one, even with a token still
 * good, on any instance from the moment of the ban.
 */
roomRoutes.post('/', async (c) => {
  const { backend, config } = c.var;
  if (!config.login) return fail(c, 503, 'login-unavailable');
  const claims = bearerOf(c, config.login);
  if (!claims) return fail(c, 401, 'login-required');
  if (!(await backend.limit(c.req.raw, 'room'))) return fail(c, 429, 'rate-limited');
  // A room costs, so it goes by the bans as they stand, read only for a good token within the limit.
  if ((await addressBanOf(c, true)) ?? (await accountBanOf(c, claims.sub, true))) return fail(c, 403, 'banned');
  if (await pausedNow(c, 'rooms')) return fail(c, 503, 'paused');
  const parsed = safeParse(createSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');

  const roomKey = randomRoomKey();
  const roomId = randomRoomId();
  const { name } = parsed.output;
  await backend.rooms.create({
    roomKey,
    roomId,
    name,
    password: parsed.output.password ?? '',
    creatorUserId: claims.uid,
    host: new URL(c.req.url).host,
    creator: { accountKey: claims.sub, address: backend.addressOf(c.req.raw) },
  });
  note(c, { kind: 'room', accountKey: claims.sub, name: claims.name, roomKey, detail: name });
  return c.json<CreateRoomResponse>({ roomKey, roomId }, 201);
});

/** Deletes a room. Only its GM can delete it, and the connections of those in it close with room-deleted. */
roomRoutes.delete('/:roomKey', async (c) => {
  const { backend, config } = c.var;
  if (!config.login) return fail(c, 503, 'login-unavailable');
  const roomKey = c.req.param('roomKey');
  if (!ROOM_KEY.test(roomKey)) return fail(c, 400, 'invalid-id');
  const claims = bearerOf(c, config.login);
  if (!claims) return fail(c, 401, 'login-required');
  if (!(await backend.limit(c.req.raw, 'room'))) return fail(c, 429, 'rate-limited');
  const result = await backend.rooms.remove(roomKey, claims.uid);
  if (result === 'not-found') return fail(c, 404, 'room-not-found');
  if (result === 'not-game-master') return fail(c, 403, 'not-game-master');
  return c.body(null, 204);
});

/** Room assets. When the room key is in the wrong form, there is no need to ask the room server. */
roomRoutes.get('/:roomKey/assets', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? listRoomAssets(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.get('/:roomKey/assets/:id', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? getRoomAsset(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.put('/:roomKey/assets/:id', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? putRoomAsset(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.delete('/:roomKey/assets/:id', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? deleteRoomAsset(c) : fail(c, 400, 'invalid-id')
);
// The steps for uploading straight to the store. A room server without them (the Cloudflare
// version) answers not-found.
roomRoutes.post('/:roomKey/assets/:id/uploads', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? requestUpload(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.post('/:roomKey/assets/:id/uploads/complete', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? completeUpload(c) : fail(c, 400, 'invalid-id')
);

/** A report to the operator, from a seat of the room. */
roomRoutes.post('/:roomKey/reports', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? postReport(c) : fail(c, 400, 'invalid-id')
);

roomRoutes.get('/:roomKey/ws', async (c) => {
  const roomKey = c.req.param('roomKey');
  if (!ROOM_KEY.test(roomKey)) return fail(c, 400, 'invalid-id');
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return fail(c, 426, 'upgrade-required');
  }
  if (!(await c.var.backend.limit(c.req.raw, 'room'))) return fail(c, 429, 'rate-limited');
  return c.var.backend.rooms.connect(c.req.raw, roomKey);
});
