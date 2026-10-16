import { ROOMS_PREFIX, UPLOADS_PREFIX, roomAssetPrefix, roomKeyOf } from '../../core/assets/keys.js';
import type { KeyOf, Redis } from '../redis.js';
import { roomKeysOf } from '../rooms/keys.js';
import { assetIndexOf } from './backend.js';
import type { AssetBucket } from './bucket.js';

// 消しそこねたアセットの掃除。部屋を消すときは索引にあるものを消すので、置いたあとで索引に書けなかった
// ものや、部屋を消す途中で落ちたものが Blob に残る。直接上げたまま知らせの来なかった仮置きも残る。
// Blob を少しずつ見て、部屋が無いか索引に無いものと、古い仮置きを消す。置かせない印は消さない
//
//   sweep:blob-cursor   STR   次に見るページ。終わりまで見たら消し、また頭から見る

/**
 * 置いてからこの時間（ミリ秒）より新しいものは消さない。置いている途中か、上げ終えた知らせを待っている
 * かもしれない（上げる先と約束は、これより早く切れる）
 */
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** Blob の1ページを見て、消しそこねたアセットを消す。消した数を返す */
export const orphanSweeper = (redis: Redis, key: KeyOf, bucket: AssetBucket) => async (): Promise<number> => {
  const cursorKey = key('sweep', 'blob-cursor');
  const page = await bucket.list('', await redis.get(cursorKey));
  const settled = Date.now() - ORPHAN_AGE_MS;
  const orphans = await Promise.all(
    page.items.map(async (item) => {
      if (item.uploadedAt > settled) return null;
      if (item.path.startsWith(UPLOADS_PREFIX)) return item.path;
      if (!item.path.startsWith(ROOMS_PREFIX)) return null;
      const roomKey = roomKeyOf(item.path);
      if (!roomKey) return item.path;
      const id = item.path.slice(roomAssetPrefix(roomKey).length);
      const [room, indexed] = await Promise.all([
        redis.exists(roomKeysOf(key, roomKey).meta),
        redis.hExists(assetIndexOf(key, roomKey), id),
      ]);
      return room === 1 && indexed === 1 ? null : item.path;
    })
  );
  const paths = orphans.filter((path): path is string => path !== null);
  await bucket.delete(paths);
  if (page.cursor) await redis.set(cursorKey, page.cursor);
  else await redis.del(cursorKey);
  return paths.length;
};
