import type { WebSocket } from 'ws';

import type { RoomSummary } from '../../contracts/protocol.js';
import type { AssetBackend, LimitKind, ServerBackend } from '../core/http/backend.js';
import { failure } from '../core/http/errors.js';
import { noModeration } from '../core/moderation/activity.js';
import type { Moderation } from '../core/moderation/activity.js';
import type { Seat } from '../core/rooms/host.js';
import { refusalFrame } from '../core/rooms/refusal.js';
import { redisAccount } from './accounts.js';
import { clientIpOf } from './limits.js';
import type { RedisLobby } from './lobby.js';
import type { KeyOf, Redis } from './redis.js';
import { createRoom, expiryKeyOf, readRoomMeta, roomKeysOf } from './rooms/keys.js';
import type { Relay } from './rooms/relay.js';
import type { RoomRuntime } from './rooms/runtime.js';
import type { RoomSweeper } from './rooms/sweep.js';

/**
 * The requests that switch over to a WebSocket. The Node server puts one here before it hands the
 * upgrade request to the app, and once the room route has made its checks, it takes the WebSocket
 * from here.
 */
export type Upgrades = WeakMap<Request, (onSocket: (ws: WebSocket) => void) => void>;

/** What the room server uses, one of each per instance. */
export interface ServerDeps {
  redis: Redis;
  key: KeyOf;
  lobby: RedisLobby;
  runtime: RoomRuntime;
  /** The relay with the other instances. */
  relay: Relay;
  /** The sweep of the rooms past their time to be deleted. */
  sweeper: RoomSweeper;
  /** The sweep of leftover assets. Looks through one page of Blob and returns how many it deleted. */
  orphans: () => Promise<number>;
  assets: AssetBackend;
  limit: (request: Request, kind: LimitKind) => Promise<boolean>;
  /** The operator's bans and what happened. */
  moderation: Moderation;
  upgrades: Upgrades;
  retentionSeconds: number;
}

/** The Vercel room server. Rooms, the room list and accounts are kept in Redis, and rooms' assets in Blob. */
export const vercelBackend = (deps: ServerDeps): ServerBackend => {
  const { redis, key, lobby, runtime, sweeper } = deps;

  /**
   * A room past its time to be deleted is not listed, even when deleting it is late. A room with no
   * time is already gone (the time is deleted along with the room).
   */
  const live = async <T extends RoomSummary>(rooms: T[]): Promise<T[]> => {
    if (rooms.length === 0) return rooms;
    const now = Date.now();
    const wipeAt = await redis.zmScore(
      expiryKeyOf(key),
      rooms.map((room) => room.roomKey)
    );
    return rooms.filter((_, index) => Number(wipeAt[index]) > now);
  };

  return {
    addressOf: clientIpOf,
    limit: deps.limit,
    lobby: {
      // Along with listing, making and joining rooms, sweeps the rooms past their time to be deleted.
      list: async (userId) => {
        sweeper.soon();
        return live(await lobby.list(userId));
      },
      find: async (roomKey, userId) => {
        const room = await lobby.find(roomKey, userId);
        return room && ((await live([room]))[0] ?? null);
      },
      all: async () => live(await lobby.all()),
      occupied: () => lobby.occupied(),
    },
    rooms: {
      create: async (init) => {
        sweeper.soon();
        const hasPassword = await createRoom(redis, key, init, deps.retentionSeconds);
        await lobby.register(
          {
            roomKey: init.roomKey,
            roomId: init.roomId,
            name: init.name,
            hasPassword,
            members: 0,
          },
          init.creator
        );
        await lobby.setGameMasters(init.roomKey, [init.creatorUserId]);
      },
      remove: (roomKey, userId) => runtime.deleteRoom(roomKey, userId),
      /**
       * Whether the person about to store an asset still has a role in this room that may store one
       * (GM or player). When this instance has the room open, its seat answers; otherwise the copy
       * of the seats the owner wrote to Redis answers.
       */
      canUpload: async (roomKey, userId) => {
        const open = await runtime.openRoom(roomKey);
        if (open && !open.isReleased) return open.engine.canUpload(userId);
        if (!(await readRoomMeta(redis, key, roomKey))) return 'room-not-found';
        const seats = await redis.hVals(roomKeysOf(key, roomKey).seats);
        const seated = seats.some((value) => {
          const seat = JSON.parse(value) as { userId: string; account: boolean; role: string };
          return seat.account && seat.userId === userId && (seat.role === 'gm' || seat.role === 'pl');
        });
        return seated ? 'ok' : 'not-a-player';
      },
      connect: async (request, roomKey) => {
        const accept = deps.upgrades.get(request);
        if (!accept) return failure(426, 'upgrade-required');
        sweeper.soon();
        accept((ws) => runtime.attach(ws, roomKey, clientIpOf(request)));
        // The connection has switched to a WebSocket, so this response is not used.
        return new Response(null);
      },
      /** Who is in the room, from the copy of the seats the owner writes to Redis. */
      seats: async (roomKey) => {
        if (!(await readRoomMeta(redis, key, roomKey))) return [];
        return (await redis.hVals(roomKeysOf(key, roomKey).seats)).map((value) => JSON.parse(value) as Seat);
      },
      expel: (roomKey, ban) => runtime.expel(roomKey, ban),
    },
    account: (accountKey) => redisAccount(redis, key, accountKey),
    assets: deps.assets,
    moderation: deps.moderation,
  };
};

/**
 * A room server with no Redis to hold rooms (when login is not set up). There are no rooms, so the
 * room list is empty, and a connection is told that there is no room and is closed.
 */
export const storelessBackend = (upgrades: Upgrades): ServerBackend => {
  const none = (): never => {
    throw new Error('There are no rooms without a store');
  };
  return {
    addressOf: clientIpOf,
    limit: async () => true,
    // The operator's dashboard answers 503 without login, so it asks nothing of these.
    lobby: { list: async () => [], find: async () => null, all: none, occupied: none },
    rooms: {
      create: none,
      remove: async () => 'not-found',
      canUpload: async () => 'room-not-found',
      seats: none,
      expel: none,
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
      inventory: none,
      content: none,
      block: none,
      unblock: none,
      blockedIds: none,
    },
    moderation: noModeration,
  };
};
