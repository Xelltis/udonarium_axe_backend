import type { Context } from 'hono';

import { ASSET_NAME_HEADER, MAX_ASSET_NAME_LENGTH } from '../../contracts/protocol';
import type { RoomAsset, RoomAssetListResponse } from '../../contracts/protocol';

import { readToken } from '../auth/tokens';
import type { Claims } from '../auth/tokens';
import type { AppEnv } from '../http/context';
import { fail } from '../http/errors';
import { networkOfRequest, withinLimits } from '../http/limits';
import { LOBBY_NAME } from '../rooms/lobby';
import { ASSET_ID, blockedKeyOf, roomAssetKey, roomAssetPrefix } from './keys';
import { objectHeaders, privately, setContentRange } from './response';
import { SNIFF_BYTES, sniff } from './sniff';
import type { AssetKind } from './sniff';
import { randomStart, sweepOrphans } from './sweep';

const MEGA_BYTE = 1024 * 1024;

/** 種類ごとの上限。クライアントが読み込む上限（file-archiver.ts）と揃える */
export const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  image: 2 * MEGA_BYTE,
  audio: 10 * MEGA_BYTE,
};

const MAX_ANY_BYTES = Math.max(...Object.values(MAX_BYTES));

/** R2 が sha256 の照合に失敗したときのエラー番号 */
const R2_BAD_DIGEST = '(10037)';

/**
 * 置いたあとに、部屋がもう無いアセットを掃除する割合。部屋のアセットは部屋が消えるときに消すので、
 * 拾うのは消しそこねたものだけ。バケットはアップロードでしか増えないので、アップロードに比例して見回る
 */
const SWEEP_CHANCE = 1 / 20;

/** Content-Length の値。無いか、0 以上の整数でなければ null */
const declaredLengthOf = (c: Context<AppEnv>): number | null => {
  const header = c.req.header('Content-Length');
  const length = Number(header);
  return header && Number.isInteger(length) && length >= 0 ? length : null;
};

/** ストリームの先頭を、size バイト以上（足りなければ最後まで）読む */
const readHead = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  size: number,
): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < size) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  return chunks;
};

/** 先に読んだ chunks と、reader の残りを1本のストリームに戻す */
const rejoin = (
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });

/**
 * 部屋のアセットのトークン。Authorization: Bearer に付いたもので、この部屋のために部屋のサーバーが
 * 渡したものだけを受ける。ログインを置いていない Worker には部屋が無いので、受けるものも無い
 */
const assetClaimsOf = (c: Context<AppEnv>, roomKey: string): Claims<'asset'> | null => {
  const login = c.var.config.login;
  const header = c.req.header('Authorization') ?? '';
  if (!login || !header.startsWith('Bearer ')) return null;
  const claims = readToken(header.slice('Bearer '.length), 'asset', login.sessionSecret);
  return claims?.room === roomKey ? claims : null;
};

/** 一覧で読む R2 のページの数の上限。1ページは 1000 件 */
const MAX_LIST_PAGES = 10;

/** PUT に付いてきた名前。読めなければ空、長ければ切る */
const assetNameOf = (c: Context<AppEnv>): string => {
  const header = c.req.header(ASSET_NAME_HEADER) ?? '';
  try {
    return decodeURIComponent(header).slice(0, MAX_ASSET_NAME_LENGTH);
  } catch {
    return '';
  }
};

/**
 * HEAD は R2 の head で答え、中身のストリームを開かない。GET と同じく、キャッシュに残っているものは
 * キャッシュから答える（GET と HEAD で答えが食い違わないように）
 */
const headAsset = async (c: Context<AppEnv>, key: string) => {
  const cached = await caches.default.match(c.req.url);
  if (cached) return privately(new Response(null, { status: 200, headers: cached.headers }));
  if (!(await withinLimits(c, c.env.READ_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  const object = await c.env.ASSETS.head(key);
  if (!object) return fail(c, 404, 'not-found');
  return privately(new Response(null, { status: 200, headers: objectHeaders(object) }));
};

/**
 * GET と HEAD /v1/rooms/:roomKey/assets/:id。この部屋のトークンを持つ人（いま部屋にいる人）に返す。
 * Hono は HEAD も GET の経路に回し、返した本文を捨てる
 */
export const getRoomAsset = async (c: Context<AppEnv>) => {
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  if (!assetClaimsOf(c, roomKey)) return fail(c, 401, 'asset-token-required');
  const key = roomAssetKey(roomKey, id);
  if (c.req.method === 'HEAD') return headAsset(c, key);

  // Worker が作った応答は CDN に残らないので、Cache API で同じデータセンターからの読み出しを受ける。
  // トークンを確かめてから引くので、キャッシュに残ったものもトークンの無い人には返らない。
  // 条件付きリクエスト（304）と Range（206）は cache.match が答える。
  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return privately(cached);

  if (!(await withinLimits(c, c.env.READ_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  // 条件付きリクエストと Range は R2 に任せる。条件が合わないと、R2 は本文の無いものを返す
  const headers = c.req.raw.headers;
  const object = await c.env.ASSETS.get(key, { onlyIf: headers, range: headers });
  if (!object) return fail(c, 404, 'not-found');

  const responseHeaders = objectHeaders(object);
  if (!('body' in object)) {
    if (headers.has('If-Match') || headers.has('If-Unmodified-Since')) {
      return fail(c, 412, 'precondition-failed');
    }
    responseHeaders.delete('Content-Length');
    return privately(new Response(null, { status: 304, headers: responseHeaders }));
  }
  if (headers.has('Range') && object.range) {
    setContentRange(responseHeaders, object.range, object.size);
    return privately(new Response(object.body, { status: 206, headers: responseHeaders }));
  }

  const response = new Response(object.body, { status: 200, headers: responseHeaders });
  c.executionCtx.waitUntil(cache.put(c.req.url, response.clone()));
  return privately(response);
};

/** PUT /v1/rooms/:roomKey/assets/:id。この部屋の GM と PL だけが置ける */
export const putRoomAsset = async (c: Context<AppEnv>) => {
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');

  const length = declaredLengthOf(c);
  if (length === null) return fail(c, 411, 'length-required');
  if (length > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  const claims = assetClaimsOf(c, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  if (claims.role === 'guest') return fail(c, 403, 'not-a-player');
  if (await c.env.ASSETS.head(blockedKeyOf(id))) return fail(c, 451, 'blocked');

  // 置いてあるものは数えずに答える。部屋に入ると、手元の画像をまとめて確かめに来るため
  const key = roomAssetKey(roomKey, id);
  if (await c.env.ASSETS.head(key)) return c.json({ id, status: 'exists' }, 200);

  // トークンは15分使えるので、いまも部屋があり、その人が置ける役割かを部屋に尋ねる
  const allowed = await c.env.ROOMS.getByName(roomKey).canUpload(claims.uid);
  if (allowed === 'room-not-found') return fail(c, 404, 'room-not-found');
  if (allowed === 'not-a-player') return fail(c, 403, 'not-a-player');

  // IPv6 は /64 ごとに数える。アドレスを替えるだけでは増やせない
  if (!(await withinLimits(c, c.env.UPLOAD_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }

  // 種類は先頭だけ読んで決め、残りは読み溜めずにそのまま R2 へ流す
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 415, 'unsupported-type');
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(
    new Uint8Array(await new Blob(head).arrayBuffer()).subarray(0, SNIFF_BYTES),
  );
  if (!sniffed) return fail(c, 415, 'unsupported-type');
  if (length > MAX_BYTES[sniffed.kind]) return fail(c, 413, 'too-large');

  // 名前と中身が合わないものは置かない。照合は R2 が書き込みながら行う
  const body = rejoin(head, reader).pipeThrough(new FixedLengthStream(length));
  const name = assetNameOf(c);
  try {
    await c.env.ASSETS.put(key, body, {
      sha256: id,
      httpMetadata: { contentType: sniffed.type },
      ...(name ? { customMetadata: { name } } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes(R2_BAD_DIGEST)) {
      return fail(c, 400, 'hash-mismatch');
    }
    throw err;
  }
  if (Math.random() < SWEEP_CHANCE) {
    const lobby = c.env.LOBBY.getByName(LOBBY_NAME);
    c.executionCtx.waitUntil(
      sweepOrphans(c.env.ASSETS, (roomKeys) => lobby.known(roomKeys), randomStart()),
    );
  }
  return c.json({ id, status: 'stored' }, 201);
};

/**
 * GET /v1/rooms/:roomKey/assets。その部屋に置いてあるアセットの一覧を、この部屋のトークンを持つ人に返す。
 * 部屋に入った人が、だれのカタログにも無いが部屋に残っているものを取りに行けるように
 */
export const listRoomAssets = async (c: Context<AppEnv>) => {
  const roomKey = c.req.param('roomKey') as string;
  if (!assetClaimsOf(c, roomKey)) return fail(c, 401, 'asset-token-required');
  if (!(await withinLimits(c, c.env.READ_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  const assets: RoomAsset[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await c.env.ASSETS.list({
      prefix: roomAssetPrefix(roomKey),
      include: ['httpMetadata', 'customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    for (const object of listed.objects) {
      const id = object.key.slice(roomAssetPrefix(roomKey).length);
      if (!ASSET_ID.test(id)) continue;
      assets.push({
        id,
        type: object.httpMetadata?.contentType ?? 'application/octet-stream',
        size: object.size,
        name: object.customMetadata?.name ?? '',
      });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  const response = c.json<RoomAssetListResponse>({ assets });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
