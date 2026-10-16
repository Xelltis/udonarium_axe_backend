import { BlobNotFoundError, del, get, head, list, put } from '@vercel/blob';

import type { VercelServerConfig } from '../../config/server.js';
import type { AssetBucket } from './bucket.js';
import { localBucket } from './local-bucket.js';

/** 一覧の1ページの数 */
const PAGE_SIZE = 1000;

/**
 * Vercel Blob の private のストア。資格は SDK が環境から読む（Vercel の上では OIDC と BLOB_STORE_ID、
 * ほかでは BLOB_READ_WRITE_TOKEN）
 */
export const blobBucket = (): AssetBucket => ({
  put: async (path, bytes, type) => {
    // 名前が中身の SHA-256 なので、同じ名前に置き直しても中身は同じ
    await put(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      access: 'private',
      contentType: type,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },
  get: async (path) => (await get(path, { access: 'private' }))?.stream ?? null,
  exists: (path) =>
    head(path).then(
      () => true,
      (err: unknown) => {
        if (err instanceof BlobNotFoundError) return false;
        throw err;
      },
    ),
  delete: async (paths) => {
    if (paths.length > 0) await del(paths);
  },
  list: async (prefix, cursor) => {
    const page = await list({ prefix, cursor: cursor ?? undefined, limit: PAGE_SIZE });
    return {
      items: page.blobs.map((blob) => ({
        path: blob.pathname,
        uploadedAt: blob.uploadedAt.getTime(),
      })),
      cursor: page.cursor ?? null,
    };
  },
});

/** 設定に合う、部屋のアセットを置くところ。BLOB_LOCAL_DIR があれば手元のディレクトリ */
export const bucketFor = (config: VercelServerConfig): AssetBucket =>
  config.blob?.kind === 'local' ? localBucket(config.blob.dir) : blobBucket();
