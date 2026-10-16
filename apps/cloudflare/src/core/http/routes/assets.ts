import type { Context } from 'hono';

import { ASSET_NAME_HEADER } from '../../../../contracts/protocol.js';
import type { RoomAssetListResponse } from '../../../../contracts/protocol.js';
import { ASSET_ID } from '../../assets/keys.js';
import { MAX_ANY_BYTES, MAX_BYTES } from '../../assets/limits.js';
import { assetNameOf } from '../../assets/names.js';
import { SNIFF_BYTES, sniff } from '../../assets/sniff.js';
import { readHead, rejoin } from '../../assets/upload.js';
import type { ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { assetClaimsOf, declaredLengthOf } from '../request.js';

type AssetContext = Context<ServerEnv>;

/**
 * GET と HEAD /v1/rooms/:roomKey/assets/:id。この部屋のトークンを持つ人（いま部屋にいる人）に返す。
 * Hono は HEAD も GET の経路に回し、返した本文を捨てる
 */
export const getRoomAsset = async (c: AssetContext) => {
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  if (!assetClaimsOf(c, c.var.config.login, roomKey)) {
    return fail(c, 401, 'asset-token-required');
  }
  const { assets } = c.var.backend;
  return c.req.method === 'HEAD'
    ? assets.head(c.req.raw, roomKey, id)
    : assets.read(c.req.raw, roomKey, id);
};

/** PUT /v1/rooms/:roomKey/assets/:id。この部屋の GM と PL だけが置ける */
export const putRoomAsset = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');

  const length = declaredLengthOf(c);
  if (length === null) return fail(c, 411, 'length-required');
  if (length > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  const claims = assetClaimsOf(c, config.login, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  if (claims.role === 'guest') return fail(c, 403, 'not-a-player');
  if (await backend.assets.blocked(id)) return fail(c, 451, 'blocked');

  // 置いてあるものは数えずに答える。部屋に入ると、手元の画像をまとめて確かめに来るため
  if (await backend.assets.exists(roomKey, id)) return c.json({ id, status: 'exists' }, 200);

  // トークンは15分使えるので、いまも部屋があり、その人が置ける役割かを部屋に尋ねる
  const allowed = await backend.rooms.canUpload(roomKey, claims.uid);
  if (allowed === 'room-not-found') return fail(c, 404, 'room-not-found');
  if (allowed === 'not-a-player') return fail(c, 403, 'not-a-player');

  // IPv6 は /64 ごとに数える。アドレスを替えるだけでは増やせない
  if (!(await backend.limit(c.req.raw, 'upload'))) return fail(c, 429, 'rate-limited');

  // 種類は先頭だけ読んで決め、残りは読み溜めずにそのまま置き場所へ流す
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 415, 'unsupported-type');
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(
    new Uint8Array(await new Blob(head).arrayBuffer()).subarray(0, SNIFF_BYTES),
  );
  if (!sniffed) return fail(c, 415, 'unsupported-type');
  if (length > MAX_BYTES[sniffed.kind]) return fail(c, 413, 'too-large');

  // 名前と中身が合わないものは置かない
  const name = assetNameOf(c.req.header(ASSET_NAME_HEADER) ?? '');
  const stored = await backend.assets.store(
    roomKey,
    id,
    rejoin(head, reader),
    length,
    sniffed.type,
    name,
  );
  if (stored === 'hash-mismatch') return fail(c, 400, 'hash-mismatch');
  // 中身を流しているあいだに部屋が削除されていたら、削除が見落とした分を消す
  if ((await backend.rooms.canUpload(roomKey, claims.uid)) === 'room-not-found') {
    await backend.assets.discard(roomKey, id);
    return fail(c, 404, 'room-not-found');
  }
  backend.assets.afterStore();
  return c.json({ id, status: 'stored' }, 201);
};

/**
 * GET /v1/rooms/:roomKey/assets。その部屋に置いてあるアセットの一覧を、この部屋のトークンを持つ人に返す。
 * 部屋に入った人が、だれのカタログにも無いが部屋に残っているものを取りに行けるように
 */
export const listRoomAssets = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  if (!assetClaimsOf(c, config.login, roomKey)) return fail(c, 401, 'asset-token-required');
  if (!(await backend.limit(c.req.raw, 'read'))) return fail(c, 429, 'rate-limited');
  const response = c.json<RoomAssetListResponse>({ assets: await backend.assets.list(roomKey) });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
