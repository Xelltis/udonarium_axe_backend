import type { RedisLobby } from '../lobby.js';
import type { KeyOf, Redis } from '../redis.js';
import { expiryKeyOf, roomKeysOf } from './keys.js';
import { wipeRoom } from './room.js';

// The sweep of rooms. In the Cloudflare version each room's alarm deletes it, but on Vercel nothing
// runs a room nobody is in. So the rooms past their time to be deleted (rooms:expiry) are deleted
// on the side of other requests, and by Vercel Cron. Until they are deleted, readers treat a room
// past its time as gone (readRoomMeta).
//
//   sweep:lock   STR   The instance that swept on the side. Runs out after SWEEP_EVERY_MS.

/** The sweep on the side runs only once in this long, across instances (milliseconds). */
export const SWEEP_EVERY_MS = 60_000;

/** How many rooms a sweep on the side deletes. */
export const SWEEP_ROOMS = 5;

/** How many rooms the Cron sweep deletes. */
export const CRON_SWEEP_ROOMS = 200;

/** How long before a room that could not be fully deleted is tried again (milliseconds). Other rooms go first. */
export const SWEEP_RETRY_MS = 60_000;

export interface SweepDeps {
  redis: Redis;
  key: KeyOf;
  lobby: RedisLobby;
  /** Deletes a room's assets. */
  deleteAssets: (roomKey: string) => Promise<void>;
  /** Work that goes on to the end even after the response is sent. */
  defer: (work: Promise<unknown>) => void;
}

export interface RoomSweeper {
  /** Sweeps on the side, after the response. Does nothing when another instance swept a little while ago. */
  soon(): void;
  /** Sweeps now. Returns how many rooms it deleted. */
  now(limit?: number): Promise<number>;
}

export const roomSweeper = (deps: SweepDeps): RoomSweeper => {
  const { redis, key } = deps;
  const expiry = expiryKeyOf(key);

  const wipe = async (roomKey: string) => {
    // Writes first that deleting has begun. Even when it cannot finish and the time is pushed later,
    // the room does not go back to being one that people can join.
    await redis.hSet(roomKeysOf(key, roomKey).meta, 'deleting', '1');
    await deps.lobby.remove(roomKey);
    // The room is deleted even when its assets cannot be. The Blob sweep deletes what is left in Blob.
    await deps.deleteAssets(roomKey).catch((err: unknown) => console.error('Room asset deletion failed:', err));
    await wipeRoom(redis, key, roomKey);
  };

  const now = async (limit = CRON_SWEEP_ROOMS): Promise<number> => {
    const due = await redis.zRangeByScore(expiry, '-inf', Date.now(), {
      LIMIT: { offset: 0, count: limit },
    });
    let swept = 0;
    for (const roomKey of due) {
      try {
        await wipe(roomKey);
        swept++;
      } catch (err) {
        console.error('Room sweep failed, to be tried again:', err);
        await redis.zAdd(expiry, { score: Date.now() + SWEEP_RETRY_MS, value: roomKey });
      }
    }
    return swept;
  };

  return {
    soon() {
      deps.defer(
        redis
          .set(key('sweep', 'lock'), '1', {
            condition: 'NX',
            expiration: { type: 'PX', value: SWEEP_EVERY_MS },
          })
          .then((taken) => (taken ? now(SWEEP_ROOMS) : 0))
          .catch((err: unknown) => console.error('Room sweep failed:', err))
      );
    },
    now,
  };
};
