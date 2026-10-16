import { createHash } from 'node:crypto';

import type { RoomAsset } from '../../../contracts/protocol.js';
import { assetHeaders, privately } from '../../core/assets/headers.js';
import { blockedKeyOf, roomAssetKey } from '../../core/assets/keys.js';
import type { AssetBackend, LimitKind } from '../../core/http/backend.js';
import { failure } from '../../core/http/errors.js';
import type { KeyOf, Redis } from '../redis.js';
import type { AssetBucket } from './bucket.js';

// 部屋のアセット。中身は AssetBucket に、索引は Redis に置く。
//
//   a:<部屋の鍵>   HASH  SHA-256 → {type, size, name, uploadedAt} の JSON
//
// 置いてあるか・ヘッダー・一覧・条件付きのリクエストは索引で答え、中身を読むのは本文を返すときだけ

/** 索引の1つ */
interface Indexed {
  type: string;
  size: number;
  name: string;
  uploadedAt: number;
}

/**
 * 1回の PUT で受けるバイト数の上限。Vercel の Function は、本文が 4.5MB を超える要求を受けない。これを
 * 超えるものは、置き場所へ直接上げてもらう
 */
export const MAX_PUT_BYTES = 4_000_000;

/** 部屋のアセットの索引の鍵 */
export const assetIndexOf = (key: KeyOf, roomKey: string): string => key('a', roomKey);

/** ETag。名前が中身の SHA-256 なので、名前から作る */
const etagOf = (id: string) => `"${id}"`;

/** If-Match・If-None-Match の値が etag に当たるか。`*`、弱い ETag、並べたものも受ける */
const matches = (header: string, etag: string): boolean =>
  header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);

/** HTTP の日付は秒まで。置いた時刻も秒に丸めて比べる */
const secondsOf = (ms: number) => Math.floor(ms / 1000);

/** Range の1つの範囲。読めないか、満たせなければ null（そのときは全体を返す） */
const rangeOf = (header: string | null, size: number): { start: number; end: number } | null => {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const [start, end] =
    match[1] === ''
      ? [Math.max(size - Number(match[2]), 0), size - 1]
      : [Number(match[1]), match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)];
  return start <= end ? { start, end } : null;
};

/** 流れてくる中身から、start から end まで（含む）を切り出す */
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
  /** 新しく置いたあとのついでの仕事（消しそこねの掃除） */
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
      // 本文は種類ごとの上限（10MiB）までなので、読み溜めてから置く。読みながら SHA-256 を求める
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

    // 置き場所が直接上げる先を作れれば（Blob）、大きいものはそこへ上げてもらう
    ...(bucket.target && {
      direct: {
        maxPutBytes: MAX_PUT_BYTES,
        target: bucket.target,
        open: (path: string) => bucket.get(path),
        discard: (path: string) => bucket.delete([path]),
      },
    }),

    /** 部屋を消すときに、その部屋のアセットをすべて消す */
    deleteRoom: async (roomKey) => {
      const ids = await redis.hKeys(assetIndexOf(key, roomKey));
      if (ids.length > 0) await bucket.delete(ids.map((id) => roomAssetKey(roomKey, id)));
      await redis.del(assetIndexOf(key, roomKey));
    },
  };
};
