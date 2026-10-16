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

/** How many items one page of a listing holds. */
const PAGE_SIZE = 1000;

/** How long a direct upload target can be used (milliseconds). */
export const TARGET_MS = 10 * 60 * 1000;

/** The Blob API version. The same as the one @vercel/blob 2.8 sends. */
const BLOB_API_VERSION = '12';

/**
 * A private Vercel Blob store. The SDK reads the credentials from the environment (OIDC and
 * BLOB_STORE_ID on Vercel, BLOB_READ_WRITE_TOKEN elsewhere).
 */
export const blobBucket = (): AssetBucket => ({
  put: async (path, bytes, type) => {
    // The name is the SHA-256 of the contents, so storing again under the same name keeps the
    // same contents.
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
    // To that path, up to that size, once, without overwriting. The store (its CDN) checks this.
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
      // What the SDK's uploadPresigned adds when it uploads from a browser.
      headers: {
        'x-api-version': BLOB_API_VERSION,
        'x-vercel-blob-access': 'private',
        'x-vercel-blob-store-id': parseStoreIdFromDelegationToken(token.delegationToken),
      },
      expiresAt: validUntil,
    };
  },
});

/** The store for the rooms' assets that fits the settings. A local directory when BLOB_LOCAL_DIR is set. */
export const bucketFor = (config: VercelServerConfig): AssetBucket =>
  config.blob?.kind === 'local' ? localBucket(config.blob.dir) : blobBucket();
