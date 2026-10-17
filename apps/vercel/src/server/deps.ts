import type { WebSocket } from 'ws';

import type { VercelServerConfig } from '../config/server.js';
import type { LimitKind, ServerBackend } from '../core/http/backend.js';
import { vercelAssets } from './assets/backend.js';
import { bucketFor } from './assets/blob-bucket.js';
import type { AssetBucket } from './assets/bucket.js';
import { orphanSweeper } from './assets/sweep.js';
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
 * The requests that switch over to a WebSocket. The Node server and the room route look at the
 * same one.
 */
export const upgrades: Upgrades = new WeakMap<Request, (onSocket: (ws: WebSocket) => void) => void>();

/** The leftover assets are swept once for every this many new assets stored. */
export const ORPHAN_SWEEP_EVERY = 20;

/**
 * Without CRON_SECRET anyone can call the sweep, so then it runs only once in this long, across
 * instances (milliseconds). Vercel Cron calls once a day.
 *
 *   sweep:unkeyed   STR   Set when the sweep ran without the secret. Runs out after this long.
 */
export const UNKEYED_SWEEP_EVERY_MS = 12 * 60 * 60 * 1000;

/** What a sweep deleted. */
export interface Swept {
  rooms: number;
  assets: number;
}

/** What can be swapped in from outside when the room server is put together (for tests and local trials). */
export interface DepsOptions {
  /** The store for the rooms' assets. When not given, it is made from blob in the settings. */
  bucketOf?: (config: VercelServerConfig) => AssetBucket;
  limits?: Readonly<Record<LimitKind, number>>;
  /** Turns login off room by room (so the tests can try a room server with login turned off). */
  withoutLogin?: Set<string>;
  /** This instance's id. */
  instance?: string;
  /** Work that goes on to the end even after the response is sent. On Vercel it is passed to waitUntil. */
  defer?: (work: Promise<unknown>) => void;
  /** Changes how long a seat is kept after the server closed it to have it reconnect (milliseconds). */
  parkMs?: number;
  /** Changes the intervals of the lease and the check (milliseconds). */
  timing?: RoomDeps['timing'];
}

/** Makes what the room server uses, one of each per instance, from the settings. */
export const createServerDeps = async (
  config: VercelServerConfig,
  options: DepsOptions,
  redis?: Redis
): Promise<ServerDeps> => {
  const connection = redis ?? (await connectRedis(config.redisUrl as string));
  const key = keyOf(config.redisKeyPrefix);
  const limit = redisLimiter(connection, key, options.limits ?? LIMITS);
  const lobby = redisLobby(connection, key);
  // Work after the response does not bring the process down when it fails. Each piece of work logs
  // its own failure.
  const defer = (work: Promise<unknown>) => {
    const settled = work.catch(() => undefined);
    options.defer?.(settled);
  };
  const bucket = (options.bucketOf ?? bucketFor)(config);
  const orphans = orphanSweeper(connection, key, bucket);
  let stored = 0;
  const assets = vercelAssets(connection, key, bucket, limit, () => {
    if (++stored % ORPHAN_SWEEP_EVERY !== 0) return;
    defer(orphans().catch((err: unknown) => console.error('Asset sweep failed:', err)));
  });
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
      sessionSecret: (roomKey) => (options.withoutLogin?.has(roomKey) ? null : (config.login?.sessionSecret ?? null)),
      // The body has a limit, so anything over it is uploaded straight to the store instead (with a
      // local directory there is no limit).
      assetUpload: assets.direct ? { maxPutBytes: assets.direct.maxPutBytes, directUpload: true } : null,
      deleteAssets,
      defer,
      timing: options.timing,
    },
    { socketSeconds: config.roomSocketSeconds, parkMs: options.parkMs },
    relay
  );
  return {
    redis: connection,
    key,
    lobby,
    runtime,
    relay,
    sweeper: roomSweeper({ redis: connection, key, lobby, deleteAssets, defer }),
    orphans,
    assets,
    limit,
    upgrades,
    retentionSeconds: config.roomRetentionSeconds,
  };
};

/**
 * The room server that fits the settings. Connects to Redis only once per instance (reuses the
 * connection for the same Redis and prefix).
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
    /**
     * Deletes the rooms past their time to be deleted, and the leftover assets (Vercel Cron). Does
     * nothing when there is no Redis to hold rooms. Without the secret, returns null when it swept
     * less than UNKEYED_SWEEP_EVERY_MS ago.
     */
    async sweep(config: VercelServerConfig, keyed: boolean): Promise<Swept | null> {
      if (!config.redisUrl) return { rooms: 0, assets: 0 };
      const deps = await depsOf(config);
      if (!keyed) {
        const taken = await deps.redis.set(deps.key('sweep', 'unkeyed'), '1', {
          condition: 'NX',
          expiration: { type: 'PX', value: UNKEYED_SWEEP_EVERY_MS },
        });
        if (!taken) return null;
      }
      return { rooms: await deps.sweeper.now(), assets: await deps.orphans() };
    },
    /** What was made (so the tests can reach inside). */
    depsFor: (config: VercelServerConfig) => made.get(`${config.redisUrl}|${config.redisKeyPrefix}`),
  };
};
