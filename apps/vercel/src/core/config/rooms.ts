import { check, optional, string } from 'valibot';

/** The bytes in one MB. */
export const MB = 1_000_000;

/**
 * How much one room may keep, added to the schema of the environment variables.
 *
 * - ROOM_STORAGE_LIMIT_MB: the most pictures and sounds one room may keep, in MB. Without it, a room
 *   keeps as many as are put (each file still has its own limit).
 */
export const roomStorageEntries = {
  ROOM_STORAGE_LIMIT_MB: optional(string()),
};

interface RoomStorageEnv {
  ROOM_STORAGE_LIMIT_MB?: string;
}

/** A whole number written in decimal. */
const WHOLE = /^\d+$/;

/** The most a room may keep is a whole number of MB above nothing. */
export const roomStorageValid = <T extends RoomStorageEnv>() =>
  check<T, string>(
    (env) =>
      !env.ROOM_STORAGE_LIMIT_MB || (WHOLE.test(env.ROOM_STORAGE_LIMIT_MB) && Number(env.ROOM_STORAGE_LIMIT_MB) > 0),
    'ROOM_STORAGE_LIMIT_MB must be a whole number of MB above 0'
  );

/** The most one room may keep in bytes, from what has passed roomStorageValid. Null when unset. */
export const roomStorageLimitOf = (env: RoomStorageEnv): number | null =>
  env.ROOM_STORAGE_LIMIT_MB ? Number(env.ROOM_STORAGE_LIMIT_MB) * MB : null;
