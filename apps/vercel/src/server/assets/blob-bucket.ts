import {
  BlobNotFoundError,
  del,
  get,
  head,
  issueSignedToken,
  list,
  parseStoreIdFromDelegationToken,
  presignUrl,
  put,
} from '@vercel/blob';

import type { VercelServerConfig } from '../../config/server.js';
import type { AssetBucket } from './bucket.js';
import { localBucket } from './local-bucket.js';

/** 一覧の1ページの数 */
const PAGE_SIZE = 1000;

/** 直接上げる先が使える時間（ミリ秒） */
export const TARGET_MS = 10 * 60 * 1000;

/** Blob の API の版。@vercel/blob 2.8 が送るものと同じ */
const BLOB_API_VERSION = '12';

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
      }
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
  target: async (path, size) => {
    const validUntil = Date.now() + TARGET_MS;
    // その場所へ、その大きさまでを、上書きせずに一度だけ。置き場所（CDN）が確かめる
    const token = await issueSignedToken({
      pathname: path,
      operations: ['put'],
      validUntil,
      maximumSizeInBytes: size,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname: path,
      access: 'private',
      validUntil,
      maximumSizeInBytes: size,
      allowOverwrite: false,
      addRandomSuffix: false,
    });
    return {
      url: presignedUrl,
      method: 'PUT',
      // SDK の uploadPresigned が、ブラウザから上げるときに付けるもの
      headers: {
        'x-api-version': BLOB_API_VERSION,
        'x-vercel-blob-access': 'private',
        'x-vercel-blob-store-id': parseStoreIdFromDelegationToken(token.delegationToken),
      },
      expiresAt: validUntil,
    };
  },
});

/** 設定に合う、部屋のアセットを置くところ。BLOB_LOCAL_DIR があれば手元のディレクトリ */
export const bucketFor = (config: VercelServerConfig): AssetBucket =>
  config.blob?.kind === 'local' ? localBucket(config.blob.dir) : blobBucket();
