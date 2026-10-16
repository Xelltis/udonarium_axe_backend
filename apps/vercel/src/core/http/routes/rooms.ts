import { Hono } from 'hono';
import { maxLength, minLength, nullish, object, pipe, safeParse, string } from 'valibot';

import { MAX_PASSWORD_LENGTH, MAX_ROOM_NAME_LENGTH } from '../../../../contracts/protocol.js';
import type { CreateRoomResponse, RoomListResponse, RoomResponse } from '../../../../contracts/protocol.js';
import type { ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { bearerOf } from '../request.js';
import { completeUpload, getRoomAsset, listRoomAssets, putRoomAsset, requestUpload } from './assets.js';

/** 部屋の鍵。128 ビットの乱数を小文字の16進で書いたもの */
const ROOM_KEY = /^[0-9a-f]{32}$/;

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const createSchema = object({
  name: pipe(string(), minLength(1), maxLength(MAX_ROOM_NAME_LENGTH)),
  password: nullish(pipe(string(), maxLength(MAX_PASSWORD_LENGTH))),
});

const randomRoomKey = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** 表示用の3文字。ぶつかっても困らない（部屋は鍵で区別する） */
const randomRoomId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) => BASE62[byte % 62]).join('');

export const roomRoutes = new Hono<ServerEnv>();

/**
 * 部屋の一覧。アクセストークンが付いていれば、その人が GM の部屋に deletable を付ける。
 * 一覧は部屋のサーバーに1つしかないので、送り元ごとに数を絞る
 */
roomRoutes.get('/', async (c) => {
  const { backend, config } = c.var;
  if (!(await backend.limit(c.req.raw, 'read'))) return fail(c, 429, 'rate-limited');
  const claims = config.login ? bearerOf(c, config.login) : null;
  const rooms = await backend.lobby.list(claims?.uid);
  return c.json<RoomListResponse>({ rooms });
});

/**
 * 鍵で1つの部屋を引く。一覧は新しい順に1000件までなので、それより古い部屋への招待リンクや、つなぎ直しが
 * 部屋を見つけられるように。数え方は一覧と同じ
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

/** 部屋を作る。ログインした人だけが作れ、作った人が GM になる。ログインを置いていなければ 503 */
roomRoutes.post('/', async (c) => {
  const { backend, config } = c.var;
  if (!config.login) return fail(c, 503, 'login-unavailable');
  const claims = bearerOf(c, config.login);
  if (!claims) return fail(c, 401, 'login-required');
  if (!(await backend.limit(c.req.raw, 'room'))) return fail(c, 429, 'rate-limited');
  const parsed = safeParse(createSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');

  const roomKey = randomRoomKey();
  const roomId = randomRoomId();
  await backend.rooms.create({
    roomKey,
    roomId,
    name: parsed.output.name,
    password: parsed.output.password ?? '',
    creatorUserId: claims.uid,
    host: new URL(c.req.url).host,
  });
  return c.json<CreateRoomResponse>({ roomKey, roomId }, 201);
});

/** 部屋を削除する。その部屋の GM だけが削除でき、入っている人は room-deleted で閉じられる */
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

/** 部屋のアセット。部屋の鍵の形が違えば、部屋のサーバーに尋ねるまでもない */
roomRoutes.get('/:roomKey/assets', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? listRoomAssets(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.get('/:roomKey/assets/:id', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? getRoomAsset(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.put('/:roomKey/assets/:id', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? putRoomAsset(c) : fail(c, 400, 'invalid-id')
);
// 置き場所へ直接上げる流れ。持たない部屋のサーバー（Cloudflare 版）では not-found
roomRoutes.post('/:roomKey/assets/:id/uploads', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? requestUpload(c) : fail(c, 400, 'invalid-id')
);
roomRoutes.post('/:roomKey/assets/:id/uploads/complete', (c) =>
  ROOM_KEY.test(c.req.param('roomKey')) ? completeUpload(c) : fail(c, 400, 'invalid-id')
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
