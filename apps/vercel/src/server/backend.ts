import type { WebSocket } from 'ws';

import type { RoomSummary } from '../../contracts/protocol.js';
import type { AssetBackend, LimitKind, ServerBackend } from '../core/http/backend.js';
import { failure } from '../core/http/errors.js';
import { refusalFrame } from '../core/rooms/refusal.js';
import { redisAccount } from './accounts.js';
import type { RedisLobby } from './lobby.js';
import type { KeyOf, Redis } from './redis.js';
import { createRoom, expiryKeyOf, readRoomMeta, roomKeysOf } from './rooms/keys.js';
import type { Relay } from './rooms/relay.js';
import type { RoomRuntime } from './rooms/runtime.js';

/**
 * WebSocket につなぎ替える要求。Node のサーバーが、upgrade の要求を app に渡す前に置き、
 * 部屋の経路が確かめ終えたら、ここから WebSocket を受ける
 */
export type Upgrades = WeakMap<Request, (onSocket: (ws: WebSocket) => void) => void>;

/** 部屋のサーバーが使う、インスタンスで1つのもの */
export interface ServerDeps {
  redis: Redis;
  key: KeyOf;
  lobby: RedisLobby;
  runtime: RoomRuntime;
  /** ほかのインスタンスとの中継 */
  relay: Relay;
  assets: AssetBackend;
  limit: (request: Request, kind: LimitKind) => Promise<boolean>;
  upgrades: Upgrades;
  retentionSeconds: number;
}

/** Vercel の部屋のサーバー。部屋・一覧・アカウントは Redis に、部屋のアセットは Blob に置く */
export const vercelBackend = (deps: ServerDeps): ServerBackend => {
  const { redis, key, lobby, runtime } = deps;

  /** 保持期間を過ぎた部屋は、消すのが遅れていても一覧に出さない */
  const live = async (rooms: RoomSummary[]): Promise<RoomSummary[]> => {
    if (rooms.length === 0) return rooms;
    const now = Date.now();
    const wipeAt = await redis.zmScore(
      expiryKeyOf(key),
      rooms.map((room) => room.roomKey),
    );
    return rooms.filter((_, index) => (wipeAt[index] ?? Infinity) > now);
  };

  return {
    limit: deps.limit,
    lobby: {
      list: async (userId) => live(await lobby.list(userId)),
      find: async (roomKey, userId) => {
        const room = await lobby.find(roomKey, userId);
        return room && ((await live([room]))[0] ?? null);
      },
    },
    rooms: {
      create: async (init) => {
        const hasPassword = await createRoom(redis, key, init, deps.retentionSeconds);
        await lobby.register({
          roomKey: init.roomKey,
          roomId: init.roomId,
          name: init.name,
          hasPassword,
          members: 0,
        });
        await lobby.setGameMasters(init.roomKey, [init.creatorUserId]);
      },
      remove: (roomKey, userId) => runtime.deleteRoom(roomKey, userId),
      /**
       * アセットを置こうとしている人が、いまもこの部屋で置ける役割（GM か PL）か。部屋をこのインスタンスで
       * 開いていればその席で、そうでなければ持ち主が Redis に書いた席の写しで答える
       */
      canUpload: async (roomKey, userId) => {
        const open = await runtime.openRoom(roomKey);
        if (open && !open.isReleased) return open.engine.canUpload(userId);
        if (!(await readRoomMeta(redis, key, roomKey))) return 'room-not-found';
        const seats = await redis.hVals(roomKeysOf(key, roomKey).seats);
        const seated = seats.some((value) => {
          const seat = JSON.parse(value) as { userId: string; account: boolean; role: string };
          return (
            seat.account && seat.userId === userId && (seat.role === 'gm' || seat.role === 'pl')
          );
        });
        return seated ? 'ok' : 'not-a-player';
      },
      connect: async (request, roomKey) => {
        const accept = deps.upgrades.get(request);
        if (!accept) return failure(426, 'upgrade-required');
        accept((ws) => runtime.attach(ws, roomKey));
        // WebSocket に替わったので、この応答は使われない
        return new Response(null);
      },
    },
    account: (accountKey) => redisAccount(redis, key, accountKey),
    assets: deps.assets,
  };
};

/**
 * 部屋を置く Redis の無い部屋のサーバー（ログインを置いていないとき）。部屋は無いので、一覧は空で、
 * つないできた人には部屋が無いと伝えて閉じる
 */
export const storelessBackend = (upgrades: Upgrades): ServerBackend => {
  const none = (): never => {
    throw new Error('There are no rooms without a store');
  };
  return {
    limit: async () => true,
    lobby: { list: async () => [], find: async () => null },
    rooms: {
      create: none,
      remove: async () => 'not-found',
      canUpload: async () => 'room-not-found',
      connect: async (request) => {
        const accept = upgrades.get(request);
        if (!accept) return failure(426, 'upgrade-required');
        accept((ws) => {
          ws.send(refusalFrame('room-not-found'));
          ws.close(4000, 'room-not-found');
        });
        return new Response(null);
      },
    },
    account: none,
    assets: {
      blocked: none,
      exists: none,
      store: none,
      discard: none,
      read: none,
      head: none,
      list: none,
      afterStore: none,
    },
  };
};
