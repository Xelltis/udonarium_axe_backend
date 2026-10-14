import { Hono } from 'hono';
import { maxLength, minLength, nullish, object, pipe, safeParse, string } from 'valibot';

import { MAX_PASSWORD_LENGTH, MAX_ROOM_NAME_LENGTH } from '../../contracts/protocol';
import type { CreateRoomResponse, RoomListResponse } from '../../contracts/protocol';
import { bearerOf } from '../auth/session';
import type { AppEnv } from '../http/context';
import { fail } from '../http/errors';
import { networkOfRequest, withinLimits } from '../http/limits';
import { LOBBY_NAME } from './lobby';

/** 部屋の鍵。128 ビットの乱数を小文字の16進で書いたもの */
const ROOM_KEY = /^[0-9a-f]{32}$/;

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const createSchema = object({
  name: pipe(string(), minLength(1), maxLength(MAX_ROOM_NAME_LENGTH)),
  password: nullish(pipe(string(), maxLength(MAX_PASSWORD_LENGTH))),
});

const randomRoomKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

/** 表示用の3文字。ぶつかっても困らない（部屋は鍵で区別する） */
const randomRoomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) => BASE62[byte % 62]).join('');

export const roomRoutes = new Hono<AppEnv>();

roomRoutes.get('/', async (c) => {
  const rooms = await c.env.LOBBY.getByName(LOBBY_NAME).list();
  return c.json<RoomListResponse>({ rooms });
});

/** 部屋を作る。ログインした人だけが作れ、作った人が GM になる。ログインを置いていなければ 503 */
roomRoutes.post('/', async (c) => {
  const login = c.var.config.login;
  if (!login) return fail(c, 503, 'login-unavailable');
  const claims = bearerOf(c, login);
  if (!claims) return fail(c, 401, 'login-required');
  if (!(await withinLimits(c, c.env.ROOM_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  const parsed = safeParse(createSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');

  const roomKey = randomRoomKey();
  const roomId = randomRoomId();
  await c.env.ROOMS.getByName(roomKey).create({
    roomKey,
    roomId,
    name: parsed.output.name,
    password: parsed.output.password ?? '',
    creatorUserId: claims.uid,
  });
  return c.json<CreateRoomResponse>({ roomKey, roomId }, 201);
});

roomRoutes.get('/:roomKey/ws', async (c) => {
  const roomKey = c.req.param('roomKey');
  if (!ROOM_KEY.test(roomKey)) return fail(c, 400, 'invalid-id');
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return fail(c, 426, 'upgrade-required');
  }
  if (!(await withinLimits(c, c.env.ROOM_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  return c.env.ROOMS.getByName(roomKey).fetch(c.req.raw);
});
