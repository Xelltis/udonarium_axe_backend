import type { RoomAsset } from '../../contracts/protocol';
import { privately } from '../core/assets/headers';
import { ASSET_ID, blockedKeyOf, roomAssetKey, roomAssetPrefix } from '../core/assets/keys';
import type { AssetBackend, LimitKind } from '../core/http/backend';
import { failure } from '../core/http/errors';
import { LOBBY_NAME } from '../rooms/lobby';
import { objectHeaders, setContentRange } from './response';
import { randomStart, sweepOrphans } from './sweep';

/** R2 が sha256 の照合に失敗したときのエラー番号 */
const R2_BAD_DIGEST = '(10037)';

/**
 * 置いたあとに、部屋がもう無いアセットを掃除する割合。部屋のアセットは部屋が消えるときに消すので、
 * 拾うのは消しそこねたものだけ。バケットはアップロードでしか増えないので、アップロードに比例して見回る
 */
const SWEEP_CHANCE = 1 / 20;

/** 一覧で読む R2 のページの数の上限。1ページは 1000 件 */
const MAX_LIST_PAGES = 10;

/** 部屋のアセットを R2 に置き、Cache API を通して配る */
export const r2Assets = (
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
  limit: (request: Request, kind: LimitKind) => Promise<boolean>
): AssetBackend => ({
  blocked: async (id) => (await env.ASSETS.head(blockedKeyOf(id))) !== null,

  exists: async (roomKey, id) => (await env.ASSETS.head(roomAssetKey(roomKey, id))) !== null,

  store: async (roomKey, id, body, length, type, name) => {
    // 照合は R2 が書き込みながら行う。長さが Content-Length と違えば、流すあいだに止まる
    try {
      await env.ASSETS.put(roomAssetKey(roomKey, id), body.pipeThrough(new FixedLengthStream(length)), {
        sha256: id,
        httpMetadata: { contentType: type },
        ...(name ? { customMetadata: { name } } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes(R2_BAD_DIGEST)) return 'hash-mismatch';
      throw err;
    }
    return 'stored';
  },

  discard: async (roomKey, id) => {
    await env.ASSETS.delete(roomAssetKey(roomKey, id));
  },

  /**
   * HEAD は R2 の head で答え、中身のストリームを開かない。GET と同じく、キャッシュに残っているものは
   * キャッシュから答える（GET と HEAD で答えが食い違わないように）
   */
  head: async (request, roomKey, id) => {
    const cached = await caches.default.match(request.url);
    if (cached) return privately(new Response(null, { status: 200, headers: cached.headers }));
    if (!(await limit(request, 'read'))) return failure(429, 'rate-limited');
    const object = await env.ASSETS.head(roomAssetKey(roomKey, id));
    if (!object) return failure(404, 'not-found');
    return privately(new Response(null, { status: 200, headers: objectHeaders(object) }));
  },

  read: async (request, roomKey, id) => {
    // Worker が作った応答は CDN に残らないので、Cache API で同じデータセンターからの読み出しを受ける。
    // トークンを確かめてから引くので、キャッシュに残ったものもトークンの無い人には返らない。
    // 条件付きリクエスト（304）と Range（206）は cache.match が答える。
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return privately(cached);

    if (!(await limit(request, 'read'))) return failure(429, 'rate-limited');
    // 条件付きリクエストと Range は R2 に任せる。条件が合わないと、R2 は本文の無いものを返す
    const headers = request.headers;
    const object = await env.ASSETS.get(roomAssetKey(roomKey, id), {
      onlyIf: headers,
      range: headers,
    });
    if (!object) return failure(404, 'not-found');

    const responseHeaders = objectHeaders(object);
    if (!('body' in object)) {
      if (headers.has('If-Match') || headers.has('If-Unmodified-Since')) {
        return failure(412, 'precondition-failed');
      }
      responseHeaders.delete('Content-Length');
      return privately(new Response(null, { status: 304, headers: responseHeaders }));
    }
    if (headers.has('Range') && object.range) {
      setContentRange(responseHeaders, object.range, object.size);
      return privately(new Response(object.body, { status: 206, headers: responseHeaders }));
    }

    const response = new Response(object.body, { status: 200, headers: responseHeaders });
    waitUntil(cache.put(request.url, response.clone()));
    return privately(response);
  },

  list: async (roomKey) => {
    const assets: RoomAsset[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await env.ASSETS.list({
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
    return assets;
  },

  afterStore: () => {
    if (Math.random() >= SWEEP_CHANCE) return;
    const lobby = env.LOBBY.getByName(LOBBY_NAME);
    waitUntil(sweepOrphans(env.ASSETS, (roomKeys) => lobby.known(roomKeys), randomStart()));
  },
});
