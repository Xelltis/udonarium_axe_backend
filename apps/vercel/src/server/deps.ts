import type { WebSocket } from 'ws';

import type { VercelServerConfig } from '../config/server.js';
import type { LimitKind, ServerBackend } from '../core/http/backend.js';
import { vercelAssets } from './assets/backend.js';
import type { AssetBucket } from './assets/bucket.js';
import { storelessBackend, vercelBackend } from './backend.js';
import type { ServerDeps, Upgrades } from './backend.js';
import { LIMITS, redisLimiter } from './limits.js';
import { redisLobby } from './lobby.js';
import { connectRedis, keyOf } from './redis.js';
import type { Redis } from './redis.js';
import { Relay } from './rooms/relay.js';
import type { RoomDeps } from './rooms/room.js';
import { RoomRuntime } from './rooms/runtime.js';
import { roomSweeper } from './rooms/sweep.js';

/**
 * WebSocket につなぎ替える要求。Node のサーバーと、部屋の経路が同じものを見る
 */
export const upgrades: Upgrades = new WeakMap<
  Request,
  (onSocket: (ws: WebSocket) => void) => void
>();

/** 部屋のサーバーを組み立てるときに、外から替えられるもの（テストと手元の試し） */
export interface DepsOptions {
  /** 部屋のアセットを置くところ。設定の blob から作る */
  bucketOf: (config: VercelServerConfig) => AssetBucket;
  limits?: Readonly<Record<LimitKind, number>>;
  /** 部屋ごとにログインを外す（テストで、ログインを外した部屋のサーバーを試すため） */
  withoutLogin?: Set<string>;
  /** このインスタンスの ID */
  instance?: string;
  /** 返したあとも終わるまで続ける仕事。Vercel の上では waitUntil に渡す */
  defer?: (work: Promise<unknown>) => void;
  /** こちらから閉じてつなぎ直させた席を、残しておく時間（ミリ秒）を替える */
  parkMs?: number;
  /** lease と見回りの間（ミリ秒）を替える */
  timing?: RoomDeps['timing'];
}

/** 設定から、インスタンスで1つの部屋のサーバーのものを作る */
export const createServerDeps = async (
  config: VercelServerConfig,
  options: DepsOptions,
  redis?: Redis,
): Promise<ServerDeps> => {
  const connection = redis ?? (await connectRedis(config.redisUrl as string));
  const key = keyOf(config.redisKeyPrefix);
  const limit = redisLimiter(connection, key, options.limits ?? LIMITS);
  const lobby = redisLobby(connection, key);
  const defer = options.defer ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
  const assets = vercelAssets(connection, key, options.bucketOf(config), limit);
  const deleteAssets = (roomKey: string) => assets.deleteRoom(roomKey);
  const instance = options.instance ?? crypto.randomUUID();
  const relay = new Relay(connection, key, instance);
  const runtime = new RoomRuntime(
    {
      redis: connection,
      key,
      lobby,
      instance,
      isAlive: (other) => relay.isAlive(other),
      retentionSeconds: config.roomRetentionSeconds,
      sessionSecret: (roomKey) =>
        options.withoutLogin?.has(roomKey) ? null : (config.login?.sessionSecret ?? null),
      deleteAssets,
      defer,
      timing: options.timing,
    },
    { socketSeconds: config.roomSocketSeconds, parkMs: options.parkMs },
    relay,
  );
  return {
    redis: connection,
    key,
    lobby,
    runtime,
    relay,
    sweeper: roomSweeper({ redis: connection, key, lobby, deleteAssets, defer }),
    assets,
    limit,
    upgrades,
    retentionSeconds: config.roomRetentionSeconds,
  };
};

/**
 * 設定に合う部屋のサーバー。Redis につなぐのはインスタンスで1度だけ（同じ Redis と頭なら使い回す）
 */
export const backendProvider = (options: DepsOptions) => {
  const made = new Map<string, Promise<ServerDeps>>();
  const depsOf = (config: VercelServerConfig): Promise<ServerDeps> => {
    const id = `${config.redisUrl}|${config.redisKeyPrefix}`;
    let deps = made.get(id);
    if (!deps) {
      deps = createServerDeps(config, options);
      made.set(id, deps);
      deps.catch(() => made.delete(id));
    }
    return deps;
  };
  return {
    async backendFor(config: VercelServerConfig): Promise<ServerBackend> {
      if (!config.redisUrl) return storelessBackend(upgrades);
      return vercelBackend(await depsOf(config));
    },
    /** 消す時刻を過ぎた部屋を消す（Vercel Cron）。消した部屋の数。部屋を置く Redis が無ければ 0 */
    async sweep(config: VercelServerConfig): Promise<number> {
      if (!config.redisUrl) return 0;
      return (await depsOf(config)).sweeper.now();
    },
    /** 作ったもの（テストが中に触るため） */
    depsFor: (config: VercelServerConfig) =>
      made.get(`${config.redisUrl}|${config.redisKeyPrefix}`),
  };
};
