import type { DirectUploadTarget } from '../../../contracts/protocol.js';

/** 置いたものの1つ */
export interface BucketItem {
  path: string;
  /** 置いた時刻（ミリ秒） */
  uploadedAt: number;
}

/** 一覧の1ページ。続きがあれば、次に渡す cursor */
export interface BucketPage {
  items: BucketItem[];
  cursor: string | null;
}

/**
 * 部屋のアセットの中身を置くところ。Vercel の上では Blob（private）、手元ではディレクトリ、テストではメモリ
 */
export interface AssetBucket {
  put(path: string, bytes: Uint8Array, type: string): Promise<void>;
  /** 中身を流す。無ければ null */
  get(path: string): Promise<ReadableStream<Uint8Array> | null>;
  exists(path: string): Promise<boolean>;
  delete(paths: string[]): Promise<void>;
  /** prefix で始まるものを、cursor から1ページ並べる */
  list(prefix: string, cursor: string | null): Promise<BucketPage>;
  /**
   * ブラウザから path へ、size バイトまでを一度だけ直接上げさせる先。作れない置き場所（手元の
   * ディレクトリ）には無い
   */
  target?(path: string, size: number): Promise<DirectUploadTarget>;
}

/**
 * メモリに置くもの。テストで使う。一覧は1ページで返す。直接上げる先は memory.example を指し、テストが
 * put でブラウザの代わりに上げる
 */
export const memoryBucket = (): AssetBucket & {
  readonly paths: () => string[];
  /** 置いた時刻を替える（消しそこねの掃除を試すため） */
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
