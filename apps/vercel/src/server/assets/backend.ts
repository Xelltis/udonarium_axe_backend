import { createHash } from 'node:crypto';

import type { RoomAsset } from '../../../contracts/protocol.js';
import { assetHeaders, privately } from '../../core/assets/headers.js';
import { blockedKeyOf, roomAssetKey } from '../../core/assets/keys.js';
import type { AssetBackend, LimitKind, StoredRoomAsset } from '../../core/http/backend.js';
import { failure } from '../../core/http/errors.js';
import type { KeyOf, Redis } from '../redis.js';
import type { AssetBucket } from './bucket.js';

// The rooms' assets. The contents are kept in the AssetBucket, and the index in Redis.
//
//   a:<room key>   HASH  SHA-256 → JSON of {type, size, name, uploadedAt}.
//
// Whether an asset is there, its headers, the list and conditional requests are answered from the
// index. The contents are read only when a body is sent back.

/** One entry in the index. */
interface Indexed {
  type: string;
  size: number;
  name: string;
  uploadedAt: number;
}

/**
 * The limit on the bytes taken in one PUT. A Vercel Function does not take a request whose body is
 * over 4.5MB. Anything over this is uploaded straight to the store instead.
 */
export const MAX_PUT_BYTES = 4_000_000;

/** The key of a room's asset index. */
export const assetIndexOf = (key: KeyOf, roomKey: string): string => key('a', roomKey);

/** The ETag. The name is the SHA-256 of the contents, so it is made from the name. */
const etagOf = (id: string) => `"${id}"`;

/** Whether an If-Match or If-None-Match value matches the etag. Takes `*`, weak ETags and lists too. */
const matches = (header: string, etag: string): boolean =>
  header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);

/** HTTP dates go down to seconds. The time an asset was stored is also rounded to seconds to compare. */
const secondsOf = (ms: number) => Math.floor(ms / 1000);

/** The single range in a Range header. Null when it cannot be read or met (the whole is then sent back). */
const rangeOf = (header: string | null, size: number): { start: number; end: number } | null => {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const [start, end] =
    match[1] === ''
      ? [Math.max(size - Number(match[2]), 0), size - 1]
      : [Number(match[1]), match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)];
  return start <= end ? { start, end } : null;
};

/** Cuts start to end (inclusive) out of the contents as they stream in. */
const slice = (stream: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> => {
  let offset = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(end + 1 - offset, chunk.byteLength);
        if (from < to) controller.enqueue(chunk.subarray(from, to));
        offset += chunk.byteLength;
      },
    })
  );
};

export const vercelAssets = (
  redis: Redis,
  key: KeyOf,
  bucket: AssetBucket,
  limit: (request: Request, kind: LimitKind) => Promise<boolean>,
  /** The work done on the side after something new is stored (the sweep of leftover assets). */
  afterStore: () => void
): AssetBackend & { deleteRoom(roomKey: string): Promise<void> } => {
  const indexed = async (roomKey: string, id: string): Promise<Indexed | null> => {
    const value = await redis.hGet(assetIndexOf(key, roomKey), id);
    return value ? (JSON.parse(value) as Indexed) : null;
  };

  const headersOf = (id: string, asset: Indexed) =>
    assetHeaders({ type: asset.type, size: asset.size, etag: etagOf(id), name: asset.name });

  return {
    blocked: (id) => bucket.exists(blockedKeyOf(id)),

    exists: async (roomKey, id) => (await redis.hExists(assetIndexOf(key, roomKey), id)) === 1,

    store: async (roomKey, id, body, length, type, name) => {
      // The body is at most the limit for its kind (10MiB), so it is read in full before it is
      // stored. The SHA-256 is worked out while it is read.
      const hash = createHash('sha256');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        chunks.push(value);
        size += value.byteLength;
      }
      if (size !== length || hash.digest('hex') !== id) return 'hash-mismatch';
      await bucket.put(roomAssetKey(roomKey, id), Buffer.concat(chunks), type);
      const asset: Indexed = { type, size, name, uploadedAt: Date.now() };
      await redis.hSet(assetIndexOf(key, roomKey), id, JSON.stringify(asset));
      return 'stored';
    },

    discard: async (roomKey, id) => {
      await bucket.delete([roomAssetKey(roomKey, id)]);
      await redis.hDel(assetIndexOf(key, roomKey), id);
    },

    head: async (request, roomKey, id) => {
      if (!(await limit(request, 'read'))) return failure(429, 'rate-limited');
      const asset = await indexed(roomKey, id);
      if (!asset) return failure(404, 'not-found');
      return privately(new Response(null, { status: 200, headers: headersOf(id, asset) }));
    },

    read: async (request, roomKey, id) => {
      if (!(await limit(request, 'read'))) return failure(429, 'rate-limited');
      const asset = await indexed(roomKey, id);
      if (!asset) return failure(404, 'not-found');
      const headers = headersOf(id, asset);
      const etag = etagOf(id);
      const ask = request.headers;
      const ifMatch = ask.get('If-Match');
      const ifUnmodifiedSince = ask.get('If-Unmodified-Since');
      if (
        (ifMatch !== null && !matches(ifMatch, etag)) ||
        (ifUnmodifiedSince !== null && secondsOf(Date.parse(ifUnmodifiedSince)) < secondsOf(asset.uploadedAt))
      ) {
        return failure(412, 'precondition-failed');
      }
      const ifNoneMatch = ask.get('If-None-Match');
      const ifModifiedSince = ask.get('If-Modified-Since');
      const unchanged =
        ifNoneMatch !== null
          ? matches(ifNoneMatch, etag)
          : ifModifiedSince !== null && secondsOf(asset.uploadedAt) <= secondsOf(Date.parse(ifModifiedSince));
      if (unchanged) {
        headers.delete('Content-Length');
        return privately(new Response(null, { status: 304, headers }));
      }
      const body = await bucket.get(roomAssetKey(roomKey, id));
      if (!body) return failure(404, 'not-found');
      const range = rangeOf(ask.get('Range'), asset.size);
      if (!range) return privately(new Response(body, { status: 200, headers }));
      const count = range.end - range.start + 1;
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${asset.size}`);
      headers.set('Content-Length', String(count));
      return privately(new Response(slice(body, range.start, range.end), { status: 206, headers }));
    },

    list: async (roomKey): Promise<RoomAsset[]> =>
      Object.entries(await redis.hGetAll(assetIndexOf(key, roomKey))).map(([id, value]) => {
        const { type, size, name } = JSON.parse(value) as Indexed;
        return { id, type, size, name };
      }),

    afterStore,

    /** One page of the rooms' indexes (SCAN), with every asset in each. */
    inventory: async (cursor) => {
      const indexPrefix = assetIndexOf(key, '');
      const page = await redis.scan(cursor ?? '0', { MATCH: `${indexPrefix}*`, COUNT: 100 });
      const assets: StoredRoomAsset[] = [];
      for (const indexKey of page.keys) {
        const roomKey = indexKey.slice(indexPrefix.length);
        for (const [id, value] of Object.entries(await redis.hGetAll(indexKey))) {
          const { type, size, name, uploadedAt } = JSON.parse(value) as Indexed;
          assets.push({ roomKey, id, type, size, name, uploadedAt });
        }
      }
      return { assets, cursor: page.cursor === '0' ? null : page.cursor };
    },

    content: async (roomKey, id) => {
      const asset = await indexed(roomKey, id);
      const body = asset && (await bucket.get(roomAssetKey(roomKey, id)));
      return body ? { body, type: (asset as Indexed).type } : null;
    },

    block: (id) => bucket.put(blockedKeyOf(id), new Uint8Array(), 'application/octet-stream'),

    unblock: (id) => bucket.delete([blockedKeyOf(id)]),

    blockedIds: async () => {
      const prefix = blockedKeyOf('');
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await bucket.list(prefix, cursor);
        ids.push(...page.items.map((item) => item.path.slice(prefix.length)));
        cursor = page.cursor;
      } while (cursor !== null);
      return ids;
    },

    // When the store can make a direct upload target (Blob), big assets are uploaded there instead.
    ...(bucket.target && {
      direct: {
        maxPutBytes: MAX_PUT_BYTES,
        target: bucket.target,
        open: (path: string) => bucket.get(path),
        discard: (path: string) => bucket.delete([path]),
      },
    }),

    /** Deletes all of a room's assets when the room is deleted. */
    deleteRoom: async (roomKey) => {
      const ids = await redis.hKeys(assetIndexOf(key, roomKey));
      if (ids.length > 0) await bucket.delete(ids.map((id) => roomAssetKey(roomKey, id)));
      await redis.del(assetIndexOf(key, roomKey));
    },
  };
};
