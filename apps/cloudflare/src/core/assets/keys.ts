/** An asset's name: the SHA-256 of its contents, written in lowercase hex. */
export const ASSET_ID = /^[0-9a-f]{64}$/;

/** The prefix under which each room's assets are kept. */
export const ROOMS_PREFIX = 'rooms/';

/**
 * Where a room's assets are kept in the store. They are kept apart for each room and deleted all
 * together when the room is deleted.
 */
export const roomAssetPrefix = (roomKey: string): string => `${ROOMS_PREFIX}${roomKey}/`;

export const roomAssetKey = (roomKey: string, id: string): string => `${roomAssetPrefix(roomKey)}${id}`;

/** Takes the room's key out of a key in the store. Null when it is not a room's asset. */
export const roomKeyOf = (key: string): string | null => {
  if (!key.startsWith(ROOMS_PREFIX)) return null;
  const roomKey = key.slice(ROOMS_PREFIX.length).split('/')[0];
  return roomKey.length > 0 ? roomKey : null;
};

/**
 * The prefix where uploads made straight to the store wait. Once checked, an upload is made a room
 * asset and the waiting one is deleted.
 */
export const UPLOADS_PREFIX = 'uploads/';

/**
 * Where an upload waits. A nonce keeps uploads apart, so they do not clash however many people
 * upload the same thing.
 */
export const uploadKeyOf = (roomKey: string, id: string, nonce: string): string =>
  `${UPLOADS_PREFIX}${roomKey}/${id}/${nonce}`;

/**
 * The mark for an asset that may not be stored. It is put there so that something deleted after,
 * for example, a claim of infringed rights cannot be uploaded again. It is empty and only its name
 * means anything (how to use it is in docs/operate/policies.md, under answering a claim of
 * infringed rights). It applies in every room.
 */
export const blockedKeyOf = (id: string): string => `blocked/${id}`;
