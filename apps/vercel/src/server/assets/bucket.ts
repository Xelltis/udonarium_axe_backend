/**
 * 部屋のアセットの中身を置くところ。Vercel の上では Blob（private）、手元ではディレクトリ、テストではメモリ
 */
export interface AssetBucket {
  put(path: string, bytes: Uint8Array, type: string): Promise<void>;
  /** 中身を流す。無ければ null */
  get(path: string): Promise<ReadableStream<Uint8Array> | null>;
  exists(path: string): Promise<boolean>;
  delete(paths: string[]): Promise<void>;
}

/** メモリに置くもの。テストで使う */
export const memoryBucket = (): AssetBucket & { readonly paths: () => string[] } => {
  const stored = new Map<string, Uint8Array>();
  return {
    put: async (path, bytes) => {
      stored.set(path, bytes);
    },
    get: async (path) => {
      const bytes = stored.get(path);
      return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() : null;
    },
    exists: async (path) => stored.has(path),
    delete: async (paths) => {
      for (const path of paths) stored.delete(path);
    },
    paths: () => [...stored.keys()],
  };
};
