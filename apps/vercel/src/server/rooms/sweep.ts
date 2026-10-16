import type { RedisLobby } from '../lobby.js';
import type { KeyOf, Redis } from '../redis.js';
import { expiryKeyOf, roomKeysOf } from './keys.js';
import { wipeRoom } from './room.js';

// 部屋の掃除。Cloudflare 版では部屋ごとの alarm が消すが、Vercel では、だれもいない部屋を動かすものが
// 無い。そこで、消す時刻（rooms:expiry）を過ぎた部屋を、ほかの要求のついでと、Vercel Cron で消す。
// 消すまでのあいだも、読む側は時刻を過ぎた部屋を無いものとして扱う（readRoomMeta）
//
//   sweep:lock   STR   ついでの掃除をしたインスタンス。SWEEP_EVERY_MS で切れる

/** ついでの掃除は、インスタンスをまたいでこの間に1度だけ（ミリ秒） */
export const SWEEP_EVERY_MS = 60_000;

/** ついでの掃除で消す部屋の数 */
export const SWEEP_ROOMS = 5;

/** Cron の掃除で消す部屋の数 */
export const CRON_SWEEP_ROOMS = 200;

/** 消しきれなかった部屋を、もう一度試すまで（ミリ秒）。ほかの部屋を先に消す */
export const SWEEP_RETRY_MS = 60_000;

export interface SweepDeps {
  redis: Redis;
  key: KeyOf;
  lobby: RedisLobby;
  /** 部屋のアセットを消す */
  deleteAssets: (roomKey: string) => Promise<void>;
  /** 返したあとも終わるまで続ける仕事 */
  defer: (work: Promise<unknown>) => void;
}

export interface RoomSweeper {
  /** ついでに掃除する。ほかのインスタンスが少し前に掃除していれば何もしない。返したあとで行う */
  soon(): void;
  /** いま掃除する。消した部屋の数を返す */
  now(limit?: number): Promise<number>;
}

export const roomSweeper = (deps: SweepDeps): RoomSweeper => {
  const { redis, key } = deps;
  const expiry = expiryKeyOf(key);

  const wipe = async (roomKey: string) => {
    // 消しはじめたことを先に書く。消しきれずに時刻を先へ延ばしても、入れる部屋には戻らない
    await redis.hSet(roomKeysOf(key, roomKey).meta, 'deleting', '1');
    await deps.lobby.remove(roomKey);
    // アセットが消せなくても部屋は消す。Blob に残ったものは、Blob の掃除が消す
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
