import type { RoomSummary } from '../../contracts/protocol.js';
import type { KeyOf, Redis } from './redis.js';

// Keeps the room list in Redis. Does the same as the Cloudflare version's LobbyDurableObject.
//
//   lobby:rooms       ZSET  room key → when the room was made (milliseconds).
//   lobby:meta        HASH  room key → JSON of {roomId, name, hasPassword}.
//   lobby:members     HASH  room key → how many people are in.
//   lobby:gms         HASH  room key → JSON array of the GMs' user ids.
//   lobby:gm:<ID>     SET   The keys of the rooms where that person is GM.
//
// The list is kept by table, not by room, so that even a thousand rooms take only a few queries.

/** The limit on how many rooms the list returns. When there are more, the newest are returned. */
export const MAX_LISTED_ROOMS = 1000;

interface Meta {
  roomId: string;
  name: string;
  hasPassword: boolean;
}

/** Sets the head count only for a listed room. KEYS are meta and members; ARGV the room key and count. */
const SET_MEMBERS = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return 1
`;

/**
 * Replaces the GMs. Takes the room out of the former GMs' indexes, and sets the new GMs only when
 * the room is in the list.
 * KEYS are meta, gms, the former GMs' indexes… and the new GMs' indexes…; ARGV are the room key,
 * the JSON of the new GMs and the number of former GMs.
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

  /** The summaries for some room keys. Leaves out the rooms not in the list (being deleted). */
  const summariesOf = async (roomKeys: string[], deletable: Set<string>) => {
    if (roomKeys.length === 0) return [];
    const [metas, members] = await Promise.all([redis.hmGet(META, roomKeys), redis.hmGet(MEMBERS, roomKeys)]);
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

  const mineOf = async (userId: string | undefined) => new Set(userId ? await redis.sMembers(gmIndexOf(userId)) : []);

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

    /** Replaces a room's GMs, but not for a room not in the list (a notice that came after it was gone). */
    async setGameMasters(roomKey: string, userIds: string[]): Promise<void> {
      const before = await gameMastersOf(roomKey);
      await redis.eval(SET_GAME_MASTERS, {
        keys: [META, GMS, ...before.map(gmIndexOf), ...userIds.map(gmIndexOf)],
        arguments: [roomKey, JSON.stringify(userIds), String(before.length)],
      });
    },

    async remove(roomKey: string): Promise<void> {
      const before = await gameMastersOf(roomKey);
      const removal = redis.multi().zRem(ROOMS, roomKey).hDel(META, roomKey).hDel(MEMBERS, roomKey).hDel(GMS, roomKey);
      for (const userId of before) removal.sRem(gmIndexOf(userId), roomKey);
      await removal.exec();
    },

    /** The given keys whose rooms are in the list. Used when sweeping assets whose room is gone. */
    async known(roomKeys: string[]): Promise<string[]> {
      if (roomKeys.length === 0) return [];
      const scores = await redis.zmScore(ROOMS, roomKeys);
      return roomKeys.filter((_, index) => scores[index] !== null);
    },

    /**
     * Newest first, up to MAX_LISTED_ROOMS. Given a userId, marks the rooms where that person is
     * GM with deletable, and always puts them in even past the count (so that a room the person
     * can delete does not drop out of the list).
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
      // Rooms made at the same time go in key order (the same order as the Cloudflare version).
      const ordered = newest
        .sort((a, b) => b.score - a.score || Number(a.value > b.value) - Number(a.value < b.value))
        .map(({ value }) => value);
      const listed = new Set(ordered);
      const extra = [...mine].filter((roomKey) => !listed.has(roomKey));
      return summariesOf([...ordered, ...extra], mine);
    },

    /**
     * The one room looked up by key. Finds even an old room that does not make the list. Null when
     * there is none. Given a userId, marks the room with deletable when that person is GM.
     */
    async find(roomKey: string, userId?: string): Promise<RoomSummary | null> {
      const [room] = await summariesOf([roomKey], await mineOf(userId));
      return room ?? null;
    },
  };
};

export type RedisLobby = ReturnType<typeof redisLobby>;
