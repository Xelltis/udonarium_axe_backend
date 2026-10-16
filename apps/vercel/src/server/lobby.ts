import type { RoomSummary } from '../../contracts/protocol.js';
import type { KeyOf, Redis } from './redis.js';

// 部屋の一覧を Redis に置く。Cloudflare 版の LobbyDurableObject と同じことをする。
//
//   lobby:rooms       ZSET  部屋の鍵 → 作った時刻（ミリ秒）
//   lobby:meta        HASH  部屋の鍵 → {roomId, name, hasPassword} の JSON
//   lobby:members     HASH  部屋の鍵 → 入っている人数
//   lobby:gms         HASH  部屋の鍵 → GM のユーザー ID の JSON 配列
//   lobby:gm:<ID>     SET   その人が GM の部屋の鍵
//
// 一覧は、千の部屋でも数回の問い合わせで引けるよう、部屋ごとではなく表ごとに置く

/** 一覧で返す部屋の数の上限。超えたら新しいものから返す */
export const MAX_LISTED_ROOMS = 1000;

interface Meta {
  roomId: string;
  name: string;
  hasPassword: boolean;
}

/** 一覧にあるときだけ人数を置く。KEYS は meta・members、ARGV は部屋の鍵・人数 */
const SET_MEMBERS = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return 1
`;

/**
 * GM を置き換える。前の GM の索引からは外し、一覧にあるときだけ新しい GM を置く。
 * KEYS は meta・gms・前の GM の索引…・新しい GM の索引…、ARGV は部屋の鍵・新しい GM の JSON・前の GM の数
 */
const SET_GAME_MASTERS = `
local before = tonumber(ARGV[3])
for i = 1, before do redis.call('SREM', KEYS[2 + i], ARGV[1]) end
redis.call('HDEL', KEYS[2], ARGV[1])
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
for i = 3 + before, #KEYS do redis.call('SADD', KEYS[i], ARGV[1]) end
return 1
`;

export const redisLobby = (redis: Redis, key: KeyOf) => {
  const ROOMS = key('lobby', 'rooms');
  const META = key('lobby', 'meta');
  const MEMBERS = key('lobby', 'members');
  const GMS = key('lobby', 'gms');
  const gmIndexOf = (userId: string) => key('lobby', 'gm', userId);

  const gameMastersOf = async (roomKey: string): Promise<string[]> =>
    JSON.parse((await redis.hGet(GMS, roomKey)) ?? '[]') as string[];

  /** 鍵の並びの要約。一覧に無いもの（消えかけ）は外す */
  const summariesOf = async (roomKeys: string[], deletable: Set<string>) => {
    if (roomKeys.length === 0) return [];
    const [metas, members] = await Promise.all([
      redis.hmGet(META, roomKeys),
      redis.hmGet(MEMBERS, roomKeys),
    ]);
    return roomKeys.flatMap((roomKey, index): RoomSummary[] => {
      const meta = metas[index];
      if (meta === null) return [];
      const { roomId, name, hasPassword } = JSON.parse(meta) as Meta;
      return [
        {
          roomKey,
          roomId,
          name,
          hasPassword,
          members: Number(members[index] ?? 0),
          ...(deletable.has(roomKey) ? { deletable: true } : {}),
        },
      ];
    });
  };

  const mineOf = async (userId: string | undefined) =>
    new Set(userId ? await redis.sMembers(gmIndexOf(userId)) : []);

  return {
    async register(room: RoomSummary): Promise<void> {
      const meta: Meta = { roomId: room.roomId, name: room.name, hasPassword: room.hasPassword };
      await redis
        .multi()
        .zAdd(ROOMS, { score: Date.now(), value: room.roomKey })
        .hSet(META, room.roomKey, JSON.stringify(meta))
        .hSet(MEMBERS, room.roomKey, String(room.members))
        .exec();
    },

    async setMembers(roomKey: string, members: number): Promise<void> {
      await redis.eval(SET_MEMBERS, {
        keys: [META, MEMBERS],
        arguments: [roomKey, String(members)],
      });
    },

    /** 部屋の GM を置き換える。一覧に無い部屋（消えたあとに届いた知らせ）のものは置かない */
    async setGameMasters(roomKey: string, userIds: string[]): Promise<void> {
      const before = await gameMastersOf(roomKey);
      await redis.eval(SET_GAME_MASTERS, {
        keys: [META, GMS, ...before.map(gmIndexOf), ...userIds.map(gmIndexOf)],
        arguments: [roomKey, JSON.stringify(userIds), String(before.length)],
      });
    },

    async remove(roomKey: string): Promise<void> {
      const before = await gameMastersOf(roomKey);
      const removal = redis
        .multi()
        .zRem(ROOMS, roomKey)
        .hDel(META, roomKey)
        .hDel(MEMBERS, roomKey)
        .hDel(GMS, roomKey);
      for (const userId of before) removal.sRem(gmIndexOf(userId), roomKey);
      await removal.exec();
    },

    /** 渡した鍵のうち、一覧にある部屋のもの。部屋がもう無いアセットを掃除するときに使う */
    async known(roomKeys: string[]): Promise<string[]> {
      if (roomKeys.length === 0) return [];
      const scores = await redis.zmScore(ROOMS, roomKeys);
      return roomKeys.filter((_, index) => scores[index] !== null);
    },

    /**
     * 新しい順に MAX_LISTED_ROOMS まで。userId を渡せば、その人が GM の部屋に deletable を付け、
     * その部屋は数に入らなくても必ず入れる（削除できる部屋が一覧から消えないように）
     */
    async list(userId?: string): Promise<RoomSummary[]> {
      const [newest, mine] = await Promise.all([
        redis.zRangeWithScores(ROOMS, '+inf', '-inf', {
          BY: 'SCORE',
          REV: true,
          LIMIT: { offset: 0, count: MAX_LISTED_ROOMS },
        }),
        mineOf(userId),
      ]);
      // 同じ時刻に作った部屋は、鍵の順に並べる（Cloudflare 版と同じ並び）
      const ordered = newest
        .sort((a, b) => b.score - a.score || Number(a.value > b.value) - Number(a.value < b.value))
        .map(({ value }) => value);
      const listed = new Set(ordered);
      const extra = [...mine].filter((roomKey) => !listed.has(roomKey));
      return summariesOf([...ordered, ...extra], mine);
    },

    /**
     * 鍵で引いた1つの部屋。一覧に載らない古い部屋でも引ける。無ければ null。userId を渡せば、その人が GM
     * なら deletable を付ける
     */
    async find(roomKey: string, userId?: string): Promise<RoomSummary | null> {
      const [room] = await summariesOf([roomKey], await mineOf(userId));
      return room ?? null;
    },
  };
};

export type RedisLobby = ReturnType<typeof redisLobby>;
