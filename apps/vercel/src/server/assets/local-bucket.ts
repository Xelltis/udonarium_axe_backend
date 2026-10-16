import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AssetBucket } from './bucket.js';

/**
 * 手元のディレクトリに置くもの。手元で試すときだけ使う（BLOB_LOCAL_DIR）。Vercel の上では
 * Function のファイルは残らないので、設定が断る
 */
export const localBucket = (dir: string): AssetBucket => {
  const fileOf = (path: string) => join(dir, ...path.split('/'));
  return {
    put: async (path, bytes) => {
      await mkdir(dirname(fileOf(path)), { recursive: true });
      await writeFile(fileOf(path), bytes);
    },
    get: async (path) => {
      try {
        return new Blob([await readFile(fileOf(path))]).stream();
      } catch {
        return null;
      }
    },
    exists: async (path) =>
      stat(fileOf(path)).then(
        () => true,
        () => false,
      ),
    delete: async (paths) => {
      await Promise.all(paths.map((path) => rm(fileOf(path), { force: true })));
    },
  };
};
