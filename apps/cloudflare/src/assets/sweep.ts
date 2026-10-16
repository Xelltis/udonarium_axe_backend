import { ASSET_ID, ROOMS_PREFIX, roomAssetPrefix, roomKeyOf } from '../core/assets/keys';

/** How many objects one sweep looks at. It is the limit of what R2's list and delete handle at once. */
const SWEEP_PAGE_SIZE = 1000;

/**
 * Even when its room is not found, an asset is not deleted for this long after it is stored, so that
 * it is not deleted when making the room and storing the asset happen out of order.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Where a sweep starts. A random value of the same shape as a room key. */
export const randomStart = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Deletes all of a room's assets. Called when a room is deleted, and when a room is deleted because its
 * retention period has passed.
 * Returns how many it deleted.
 */
export const deleteRoomAssets = async (bucket: R2Bucket, roomKey: string): Promise<number> => {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: roomAssetPrefix(roomKey),
      limit: SWEEP_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
};

/**
 * Looks at one page after start and deletes the assets whose room is gone. Returns how many it deleted.
 * It picks up those missed when their room went (as when the server went down partway).
 *
 * Room keys are random, so picking a random place to start each time covers the whole bucket in the
 * end, without remembering how far it got. It also deletes the assets that belong to no room, from
 * before assets were split by room (those with only a name).
 */
export const sweepOrphans = async (
  bucket: R2Bucket,
  knownRooms: (roomKeys: string[]) => Promise<string[]>,
  start: string
): Promise<number> => {
  const { objects } = await bucket.list({
    prefix: ROOMS_PREFIX,
    startAfter: `${ROOMS_PREFIX}${start}`,
    limit: SWEEP_PAGE_SIZE,
  });
  const roomKeys = [...new Set(objects.map((object) => roomKeyOf(object.key) as string))];
  const known = new Set(roomKeys.length > 0 ? await knownRooms(roomKeys) : []);
  const now = Date.now();
  const orphans = objects
    .filter((object) => !known.has(roomKeyOf(object.key) as string))
    .filter((object) => now - object.uploaded.getTime() > ORPHAN_GRACE_MS)
    .map((object) => object.key);

  // Those from before the split by room sit at the head of the bucket under only a name (64 hex digits).
  const unscoped = await bucket.list({ startAfter: start, limit: SWEEP_PAGE_SIZE });
  const legacy = unscoped.objects.map((object) => object.key).filter((key) => ASSET_ID.test(key));

  const doomed = [...orphans, ...legacy];
  if (doomed.length > 0) await bucket.delete(doomed);
  return doomed.length;
};
