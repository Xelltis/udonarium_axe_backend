import type { Context } from 'hono';
import { integer, minValue, number, object, optional, pipe, safeParse, string } from 'valibot';

import { ASSET_NAME_HEADER } from '../../../../contracts/protocol.js';
import type {
  AssetStoredResponse,
  RoomAssetListResponse,
  UploadTicketResponse,
} from '../../../../contracts/protocol.js';
import { ASSET_ID, uploadKeyOf } from '../../assets/keys.js';
import { MAX_ANY_BYTES, MAX_BYTES } from '../../assets/limits.js';
import { assetNameOf } from '../../assets/names.js';
import { SNIFF_BYTES, sniff } from '../../assets/sniff.js';
import { joinChunks, readHead, rejoin } from '../../assets/upload.js';
import { UPLOAD_TICKET_SECONDS, readToken, signToken } from '../../auth/tokens.js';
import type { Claims } from '../../auth/tokens.js';
import type { LoginConfig } from '../../config/login.js';
import type { DirectUploads, ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { assetClaimsOf, declaredLengthOf } from '../request.js';

type AssetContext = Context<ServerEnv>;

const ticketSchema = object({
  size: pipe(number(), integer(), minValue(1)),
  name: optional(string()),
});

const completeSchema = object({ ticket: string() });

/**
 * 置いてよいかを、PUT と直接上げる流れで同じ順に確かめる。置けなければ断る応答を、もう置いてあれば
 * exists の応答を返す。count なら、置くたびに数える上限も確かめる
 */
const admit = async (
  c: AssetContext,
  roomKey: string,
  id: string,
  count: boolean,
): Promise<Response | Claims<'asset'>> => {
  const { backend, config } = c.var;
  const claims = assetClaimsOf(c, config.login, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  if (claims.role === 'guest') return fail(c, 403, 'not-a-player');
  if (await backend.assets.blocked(id)) return fail(c, 451, 'blocked');

  // 置いてあるものは数えずに答える。部屋に入ると、手元の画像をまとめて確かめに来るため
  if (await backend.assets.exists(roomKey, id)) {
    return c.json<AssetStoredResponse>({ id, status: 'exists' }, 200);
  }

  // トークンは15分使えるので、いまも部屋があり、その人が置ける役割かを部屋に尋ねる
  const allowed = await backend.rooms.canUpload(roomKey, claims.uid);
  if (allowed === 'room-not-found') return fail(c, 404, 'room-not-found');
  if (allowed === 'not-a-player') return fail(c, 403, 'not-a-player');

  // IPv6 は /64 ごとに数える。アドレスを替えるだけでは増やせない
  if (count && !(await backend.limit(c.req.raw, 'upload'))) return fail(c, 429, 'rate-limited');
  return claims;
};

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
  const { backend } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');

  const length = declaredLengthOf(c);
  if (length === null) return fail(c, 411, 'length-required');
  // 本文の大きさに上限のある部屋のサーバーは、それを超えるものを直接上げてもらう
  if (length > (backend.assets.direct?.maxPutBytes ?? MAX_ANY_BYTES)) {
    return fail(c, 413, 'too-large');
  }

  const claims = await admit(c, roomKey, id, true);
  if (claims instanceof Response) return claims;

  // 種類は先頭だけ読んで決め、残りは読み溜めずにそのまま置き場所へ流す
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 415, 'unsupported-type');
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(joinChunks(head).subarray(0, SNIFF_BYTES));
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
  return c.json<AssetStoredResponse>({ id, status: 'stored' }, 201);
};

/**
 * POST /v1/rooms/:roomKey/assets/:id/uploads。PUT の本文に収まらないものを、置き場所へ直接上げる先を
 * 渡す。確かめる順は PUT と同じ。種類と中身は、上げ終えた知らせを受けてから確かめる
 */
export const requestUpload = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  const direct = backend.assets.direct;
  if (!direct) return fail(c, 404, 'not-found');
  const parsed = safeParse(ticketSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');
  const { size } = parsed.output;
  if (size > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  const claims = await admit(c, roomKey, id, true);
  if (claims instanceof Response) return claims;

  const path = uploadKeyOf(roomKey, id, crypto.randomUUID());
  const upload = await direct.target(path, size);
  // 部屋のサーバーは何も覚えておかない。上げ終えた知らせに、この約束を付けてもらう
  const ticket = signToken<'upload'>(
    {
      aud: 'upload',
      room: roomKey,
      id,
      uid: claims.uid,
      size,
      name: assetNameOf(parsed.output.name ?? ''),
      path,
    },
    UPLOAD_TICKET_SECONDS,
    (config.login as LoginConfig).sessionSecret,
  );
  return c.json<UploadTicketResponse>({ ticket, upload }, 201);
};

/**
 * POST /v1/rooms/:roomKey/assets/:id/uploads/complete。上げ終えたものを確かめて、部屋のアセットにする。
 * 確かめたあとは（置けても置けなくても）仮置きを消す
 */
export const completeUpload = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  const direct = backend.assets.direct;
  if (!direct) return fail(c, 404, 'not-found');
  const parsed = safeParse(completeSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');

  const claims = assetClaimsOf(c, config.login, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  // 約束は、この部屋のこのアセットのために、この人へ出したものだけを受ける
  const secret = (config.login as LoginConfig).sessionSecret;
  const ticket = readToken(parsed.output.ticket, 'upload', secret);
  if (!ticket || ticket.room !== roomKey || ticket.id !== id || ticket.uid !== claims.uid) {
    return fail(c, 400, 'invalid-request');
  }
  try {
    return await keepUpload(c, direct, roomKey, ticket);
  } finally {
    await direct.discard(ticket.path);
  }
};

/** 仮置きを確かめて、部屋のアセットにする。確かめる順と答えは PUT と同じ */
const keepUpload = async (
  c: AssetContext,
  direct: DirectUploads,
  roomKey: string,
  ticket: Claims<'upload'>,
): Promise<Response> => {
  const { backend } = c.var;
  const { id } = ticket;
  const admitted = await admit(c, roomKey, id, false);
  if (admitted instanceof Response) return admitted;

  const body = await direct.open(ticket.path);
  if (!body) return fail(c, 404, 'not-found');
  const reader = body.getReader();
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(joinChunks(head).subarray(0, SNIFF_BYTES));
  if (!sniffed) {
    await reader.cancel();
    return fail(c, 415, 'unsupported-type');
  }
  if (ticket.size > MAX_BYTES[sniffed.kind]) {
    await reader.cancel();
    return fail(c, 413, 'too-large');
  }

  const stored = await backend.assets.store(
    roomKey,
    id,
    rejoin(head, reader),
    ticket.size,
    sniffed.type,
    ticket.name,
  );
  if (stored === 'hash-mismatch') return fail(c, 400, 'hash-mismatch');
  // 確かめているあいだに部屋が削除されていたら、削除が見落とした分を消す
  if ((await backend.rooms.canUpload(roomKey, admitted.uid)) === 'room-not-found') {
    await backend.assets.discard(roomKey, id);
    return fail(c, 404, 'room-not-found');
  }
  backend.assets.afterStore();
  return c.json<AssetStoredResponse>({ id, status: 'stored' }, 201);
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
