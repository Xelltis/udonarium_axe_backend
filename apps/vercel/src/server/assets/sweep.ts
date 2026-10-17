import { ROOMS_PREFIX, UPLOADS_PREFIX, roomAssetPrefix, roomKeyOf } from '../../core/assets/keys.js';
import type { KeyOf, Redis } from '../redis.js';
import { roomKeysOf } from '../rooms/keys.js';
import { assetIndexOf } from './backend.js';
import type { AssetBucket } from './bucket.js';

// The sweep of leftover assets. Deleting a room deletes what is in its index, so what was stored
// but could not be written to the index, and what was left when the server went down partway
// through deleting a room, stay in Blob. Temporary uploads that went up directly but whose notice
// never came also stay. The sweep looks through Blob a little at a time, and deletes what has no
// room or is not in the index, and old temporary uploads. It does not delete the marks that keep an
// asset from being stored.
//
//   sweep:blob-cursor   STR   The page to look at next. Deleted at the end, to start from the top again.

/**
 * What was stored less than this long ago (milliseconds) is not deleted. It may still be being
 * stored, or waiting for the notice that the upload is done (the target and the ticket run out
 * sooner than this).
 */
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** Looks through one page of Blob and deletes the leftover assets. Returns how many it deleted. */
export const orphanSweeper = (redis: Redis, key: KeyOf, bucket: AssetBucket) => async (): Promise<number> => {
  const cursorKey = key('sweep', 'blob-cursor');
  const page = await bucket.list('', await redis.get(cursorKey));
  const settled = Date.now() - ORPHAN_AGE_MS;
  const paths: string[] = [];
  const byRoom = new Map<string, { id: string; path: string }[]>();
  for (const item of page.items) {
    if (item.uploadedAt > settled) continue;
    if (item.path.startsWith(UPLOADS_PREFIX)) {
      paths.push(item.path);
      continue;
    }
    if (!item.path.startsWith(ROOMS_PREFIX)) continue;
    const roomKey = roomKeyOf(item.path);
    if (!roomKey) {
      paths.push(item.path);
      continue;
    }
    const held = byRoom.get(roomKey) ?? [];
    held.push({ id: item.path.slice(roomAssetPrefix(roomKey).length), path: item.path });
    byRoom.set(roomKey, held);
  }
  await Promise.all(
    [...byRoom].map(async ([roomKey, held]) => {
      const [room, indexed] = await Promise.all([
        redis.exists(roomKeysOf(key, roomKey).meta),
        redis.hmGet(
          assetIndexOf(key, roomKey),
          held.map((asset) => asset.id)
        ),
      ]);
      held.forEach((asset, at) => {
        if (room !== 1 || indexed[at] === null) paths.push(asset.path);
      });
    })
  );
  await bucket.delete(paths);
  if (page.cursor) await redis.set(cursorKey, page.cursor);
  else await redis.del(cursorKey);
  return paths.length;
};
