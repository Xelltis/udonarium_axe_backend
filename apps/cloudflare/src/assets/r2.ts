import type { RoomAsset } from '../../contracts/protocol';
import { privately } from '../core/assets/headers';
import { ASSET_ID, blockedKeyOf, roomAssetKey, roomAssetPrefix } from '../core/assets/keys';
import type { AssetBackend, LimitKind } from '../core/http/backend';
import { failure } from '../core/http/errors';
import { LOBBY_NAME } from '../rooms/lobby';
import { objectHeaders, setContentRange } from './response';
import { randomStart, sweepOrphans } from './sweep';

/** The error number R2 gives when the sha256 check fails. */
const R2_BAD_DIGEST = '(10037)';

/**
 * The chance, after an asset is stored, of sweeping away assets whose room is gone. A room's assets
 * are deleted when the room goes, so this picks up only those that were missed. The bucket grows only
 * through uploads, so it is swept in step with uploads.
 */
const SWEEP_CHANCE = 1 / 20;

/** The limit on how many R2 pages a listing reads. A page holds 1000 objects. */
const MAX_LIST_PAGES = 10;

/** Keeps a room's assets in R2 and serves them through the Cache API. */
export const r2Assets = (
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
  limit: (request: Request, kind: LimitKind) => Promise<boolean>
): AssetBackend => ({
  blocked: async (id) => (await env.ASSETS.head(blockedKeyOf(id))) !== null,

  exists: async (roomKey, id) => (await env.ASSETS.head(roomAssetKey(roomKey, id))) !== null,

  store: async (roomKey, id, body, length, type, name) => {
    // R2 checks the hash while it writes. When the length differs from Content-Length, it stops
    // mid-stream.
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
   * Answers HEAD with R2's head and does not open the body's stream. As with GET, what is left in the
   * cache is answered from the cache (so that GET and HEAD do not give different answers).
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
    // A response a Worker makes does not stay in the CDN, so the Cache API takes the reads from the same
    // data center. The cache is looked up after the token is checked, so even what is left in the cache
    // does not go back to someone without a token.
    // cache.match answers conditional requests (304) and Range (206).
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return privately(cached);

    if (!(await limit(request, 'read'))) return failure(429, 'rate-limited');
    // Conditional requests and Range are left to R2. When the condition fails, R2 returns one without
    // a body.
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
