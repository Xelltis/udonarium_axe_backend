import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import type { AssetBucket, BucketItem } from './bucket.js';

/**
 * 手元のディレクトリに置くもの。手元で試すときだけ使う（BLOB_LOCAL_DIR）。Vercel の上では
 * Function のファイルは残らないので、設定が断る。一覧は1ページで返す
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
    list: async (prefix) => {
      const base = fileOf(prefix);
      const names = await readdir(base, { recursive: true }).catch(() => []);
      const items: BucketItem[] = [];
      for (const name of names) {
        const info = await stat(join(base, name));
        if (info.isFile()) {
          items.push({ path: `${prefix}${name.split(sep).join('/')}`, uploadedAt: info.mtimeMs });
        }
      }
      return { items, cursor: null };
    },
  };
};
