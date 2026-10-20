import type { RoomAsset } from '../../contracts/protocol';
import { privately } from '../core/assets/headers';
import { ASSET_ID, ROOMS_PREFIX, blockedKeyOf, roomAssetKey, roomAssetPrefix } from '../core/assets/keys';
import type { AssetBackend, LimitKind, StoredRoomAsset } from '../core/http/backend';
import { failure } from '../core/http/errors';
import { BAN_CACHE_MS } from '../core/moderation/bans';
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

/** Where the marks that bar an asset are kept. */
const BLOCKED_PREFIX = blockedKeyOf('');

/** A room's key (as in the store's key of its assets). */
const ROOM_KEY = /^[0-9a-f]{32}$/;

/** The ids of what is barred from being stored, up to MAX_LIST_PAGES pages of them. */
const listBlocked = async (bucket: R2Bucket): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({ prefix: BLOCKED_PREFIX, ...(cursor ? { cursor } : {}) });
    ids.push(...listed.objects.map((object) => object.key.slice(BLOCKED_PREFIX.length)));
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return ids;
};

/**
 * What is barred, as this isolate read it a short while ago (BAN_CACHE_MS, as for the bans). A read
 * answered from the Cache API never reaches R2, so a copy left in a data center is checked against
 * it: one taken down stops being served there too within that while. Taking down or letting back on
 * this isolate reads it afresh, and a read that fails is not kept.
 */
let barred: { ids: Promise<Set<string>>; at: number } | null = null;

const barredNow = (bucket: R2Bucket): Promise<Set<string>> => {
  const now = Date.now();
  if (!barred || now - barred.at >= BAN_CACHE_MS) {
    const ids = listBlocked(bucket).then(
      (listed) => new Set(listed),
      (err: unknown) => {
        barred = null;
        throw err;
      }
    );
    barred = { ids, at: now };
  }
  return barred.ids;
};

/** The assets kept for a room, up to MAX_LIST_PAGES pages of them. */
const listRoom = async (bucket: R2Bucket, roomKey: string): Promise<RoomAsset[]> => {
  const assets: RoomAsset[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await bucket.list({
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
};

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
    await env.ROOMS.getByName(roomKey).keepAsset(id, length);
    return 'stored';
  },

  discard: async (roomKey, id) => {
    await env.ASSETS.delete(roomAssetKey(roomKey, id));
    await env.ROOMS.getByName(roomKey).dropAsset(id);
  },

  /**
   * Answers HEAD with R2's head and does not open the body's stream. As with GET, what is left in the
   * cache is answered from the cache (so that GET and HEAD do not give different answers).
   */
  head: async (request, roomKey, id) => {
    if ((await barredNow(env.ASSETS)).has(id)) return failure(451, 'blocked');
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
    if ((await barredNow(env.ASSETS)).has(id)) return failure(451, 'blocked');
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

  list: (roomKey) => listRoom(env.ASSETS, roomKey),

  /**
   * What the room's assets take up, as the room keeps it. The first time, they are listed and
   * counted, and the room keeps the count from then on.
   */
  usage: async (roomKey) => {
    const room = env.ROOMS.getByName(roomKey);
    const kept = await room.assetBytes();
    if (kept !== null) return kept;
    const listed = await listRoom(env.ASSETS, roomKey);
    return room.countAssetBytes(listed.map(({ id, size }) => ({ id, size })));
  },

  inventory: async (cursor) => {
    const listed = await env.ASSETS.list({
      prefix: ROOMS_PREFIX,
      include: ['httpMetadata', 'customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    const assets: StoredRoomAsset[] = [];
    for (const object of listed.objects) {
      const [roomKey, id, ...rest] = object.key.slice(ROOMS_PREFIX.length).split('/');
      if (!ROOM_KEY.test(roomKey) || !ASSET_ID.test(id) || rest.length > 0) continue;
      assets.push({
        roomKey,
        id,
        type: object.httpMetadata?.contentType ?? 'application/octet-stream',
        size: object.size,
        name: object.customMetadata?.name ?? '',
        uploadedAt: object.uploaded.getTime(),
      });
    }
    return { assets, cursor: listed.truncated ? listed.cursor : null };
  },

  content: async (roomKey, id) => {
    const object = await env.ASSETS.get(roomAssetKey(roomKey, id));
    return object && { body: object.body, type: object.httpMetadata?.contentType ?? 'application/octet-stream' };
  },

  block: async (id) => {
    await env.ASSETS.put(blockedKeyOf(id), new Uint8Array());
    barred = null;
  },

  unblock: async (id) => {
    await env.ASSETS.delete(blockedKeyOf(id));
    barred = null;
  },

  blockedIds: () => listBlocked(env.ASSETS),

  afterStore: () => {
    if (Math.random() >= SWEEP_CHANCE) return;
    const lobby = env.LOBBY.getByName(LOBBY_NAME);
    waitUntil(sweepOrphans(env.ASSETS, (roomKeys) => lobby.known(roomKeys), randomStart()));
  },
});
