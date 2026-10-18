import type { DirectUploadTarget } from '../../../contracts/protocol.js';

/** One stored item. */
export interface BucketItem {
  path: string;
  /** When it was stored (milliseconds). */
  uploadedAt: number;
}

/** One page of a listing, and the cursor to pass next when there is more. */
export interface BucketPage {
  items: BucketItem[];
  cursor: string | null;
}

/**
 * The store for the contents of the rooms' assets. Blob (private) on Vercel, a directory locally,
 * and memory in the tests.
 */
export interface AssetBucket {
  put(path: string, bytes: Uint8Array, type: string): Promise<void>;
  /** Streams the contents. Null when there is no such item. */
  get(path: string): Promise<ReadableStream<Uint8Array> | null>;
  exists(path: string): Promise<boolean>;
  delete(paths: string[]): Promise<void>;
  /** Lists one page of the items that start with prefix, from cursor on. */
  list(prefix: string, cursor: string | null): Promise<BucketPage>;
  /**
   * A target that lets a browser upload up to size bytes straight to path, once. A store that
   * cannot make one (a local directory) does not have it.
   */
  target?(path: string, size: number): Promise<DirectUploadTarget>;
}

/**
 * A store in memory, used in the tests. It lists everything in one page. Its direct upload target
 * points at memory.example, and the test uploads with put in place of the browser.
 */
export const memoryBucket = (): AssetBucket & {
  readonly paths: () => string[];
  /** Changes when an item was stored (to test the sweep of leftover assets). */
  age(path: string, uploadedAt: number): void;
} => {
  const stored = new Map<string, { bytes: Uint8Array; uploadedAt: number }>();
  return {
    put: async (path, bytes) => {
      stored.set(path, { bytes, uploadedAt: Date.now() });
    },
    get: async (path) => {
      const item = stored.get(path);
      return item ? new Blob([item.bytes as Uint8Array<ArrayBuffer>]).stream() : null;
    },
    exists: async (path) => stored.has(path),
    delete: async (paths) => {
      for (const path of paths) stored.delete(path);
    },
    list: async (prefix) => ({
      items: [...stored]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, { uploadedAt }]) => ({ path, uploadedAt })),
      cursor: null,
    }),
    target: async (path, size) => ({
      url: `https://memory.example/${path}`,
      method: 'PUT',
      headers: { 'x-size': String(size) },
      expiresAt: Date.now() + 10 * 60 * 1000,
    }),
    paths: () => [...stored.keys()],
    age: (path, uploadedAt) => {
      (stored.get(path) as { uploadedAt: number }).uploadedAt = uploadedAt;
    },
  };
};
