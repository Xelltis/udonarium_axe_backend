import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { parseServerConfig } from '../src/config/server.js';
import { blockedKeyOf } from '../src/core/assets/keys.js';
import { createApp } from '../src/http/app.js';
import { memoryBucket } from '../src/server/assets/bucket.js';
import { MAX_PUT_BYTES, assetIndexOf } from '../src/server/assets/backend.js';
import { backendProvider, upgrades } from '../src/server/deps.js';
import { redisModeration } from '../src/server/moderation.js';
import { createServer } from '../src/server/node.js';
import { closeWhenDone } from './cleanup.js';
import type { Harness, TestSocket } from './shared/harness-api.js';

// Runs the shared tests on the Node server and Redis. Each test file gets one room server, with its
// own Redis prefix and assets kept in memory. The test files of a worker share their modules (the
// tests run without isolation), so the room server is started the first time a file uses it and
// closed when that file is done (test/setup.ts).

/** A room server for one test file. */
const start = async () => {
  const env: Record<string, string | undefined> = {
    ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example,http://localhost:4200',
    DISCORD_CLIENT_ID: 'test-client',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    ADMIN_DISCORD_IDS: '100000000000000001',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    REDIS_KEY_PREFIX: `test:${crypto.randomUUID()}:`,
    BLOB_STORE_ID: 'memory',
  };
  const config = parseServerConfig(env);
  const bucket = memoryBucket();
  const withoutLogin = new Set<string>();
  /** Work that goes on after the response. fetchWith waits until it is done before it returns. */
  const deferred = new Set<Promise<unknown>>();
  const provider = backendProvider({
    bucketOf: () => bucket,
    // The tests make the limits small, to check 429 in a few requests.
    limits: { upload: 5, read: 5, room: 5, auth: 5 },
    withoutLogin,
    defer: (work) => {
      const tracked = work.catch(() => undefined).finally(() => deferred.delete(tracked));
      deferred.add(tracked);
    },
  });

  const appWith = (overrides: Record<string, string | undefined>) =>
    createApp({
      server: { env: () => ({ ...env, ...overrides }), backendFor: provider.backendFor, sweep: provider.sweep },
    });
  const app = appWith({});
  const server = createServer(app.fetch, upgrades);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  // The room server is made first, with the test settings. If fetchWith made it first with other
  // settings, the rooms would run with those settings.
  const backend = await provider.backendFor(config);
  const deps = await (provider.depsFor(config) as NonNullable<ReturnType<typeof provider.depsFor>>);

  return {
    bucket,
    withoutLogin,
    deferred,
    app,
    appWith,
    port,
    backend,
    deps,
    // Waits for the work still finishing (dice being rolled and so on), and lets the rooms go before
    // closing, so that nothing is written after the tests.
    async close() {
      await Promise.all([...deferred]);
      await deps.runtime.close();
      server.close();
      server.closeAllConnections();
      deps.redis.destroy();
    },
  };
};

let current: ReturnType<typeof start> | null = null;

/** The room server of the test file running. */
const instance = () => {
  if (!current) {
    const started = start();
    current = started;
    closeWhenDone(async () => {
      current = null;
      await (await started).close();
    });
  }
  return current;
};

/** The store for the rooms' assets. The direct upload tests upload here in place of the browser. */
export const harnessBucket = async () => (await instance()).bucket;

/** The tests write the sender in CF-Connecting-IP. On Vercel it goes in x-real-ip. */
const vercelHeaders = (headers: Headers): Headers => {
  const moved = new Headers(headers);
  const ip = moved.get('CF-Connecting-IP');
  if (ip) moved.set('x-real-ip', ip);
  return moved;
};

const forVercel = (request: Request): Request => new Request(request, { headers: vercelHeaders(request.headers) });

/** Turns a ws client into the tests' shape. Keeps what comes in before a listener is attached. */
const socketOf = (ws: WebSocket): TestSocket => {
  const inbox: (ArrayBuffer | string)[] = [];
  let onMessage: ((data: ArrayBuffer | string) => void) | null = null;
  let closed: { code: number; reason: string } | null = null;
  let onClose: ((code: number, reason: string) => void) | null = null;
  ws.on('message', (data: Buffer, isBinary) => {
    const message = isBinary
      ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      : data.toString();
    if (onMessage) onMessage(message);
    else inbox.push(message);
  });
  ws.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() };
    onClose?.(code, closed.reason);
  });
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onMessage: (listener) => {
      onMessage = listener;
      for (const message of inbox.splice(0)) listener(message);
    },
    onClose: (listener) => {
      onClose = listener;
      if (closed) listener(closed.code, closed.reason);
    },
  };
};

export const harness: Harness = {
  // Blob can have anything over the body limit uploaded directly. The memory store is set up the same.
  assetUpload: { maxPutBytes: MAX_PUT_BYTES, directUpload: true },

  fetch: async (request) => (await instance()).app.fetch(forVercel(request)),

  fetchWith: async (request, overrides) => {
    const { appWith, deferred } = await instance();
    const res = await appWith(overrides).fetch(forVercel(request));
    await Promise.all([...deferred]);
    return res;
  },

  upgrade: async (request) => {
    // A request that is not for a WebSocket is sent as plain HTTP.
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const res = await harness.fetch(request);
      return { status: res.status, socket: null, json: () => res.json() };
    }
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    vercelHeaders(request.headers).forEach((value, name) => {
      if (name !== 'upgrade') headers[name] = value;
    });
    const ws = new WebSocket(`ws://127.0.0.1:${(await instance()).port}${url.pathname}${url.search}`, {
      headers,
    });
    const socket = socketOf(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ status: 101, socket, json: async () => null }));
      ws.once('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode as number,
            socket: null,
            json: async () => JSON.parse(body),
          });
        });
      });
      ws.once('error', reject);
    });
  },

  inside: async (roomKey, run) =>
    (await instance()).deps.runtime.withRoom(roomKey, (room) =>
      run({ engine: room.engine as never, host: room as never })
    ),

  createRoom: async (init) => (await instance()).backend.rooms.create(init),

  canUpload: async (roomKey, userId) => (await instance()).backend.rooms.canUpload(roomKey, userId),

  dropLogin: async (roomKey) => {
    (await instance()).withoutLogin.add(roomKey);
  },

  expireLoginCode: async (accountKey, id) => {
    const { redis, key } = (await instance()).deps;
    await redis.hSet(key('acct', accountKey, 'code', id), 'expiresAt', '0');
  },

  expireRefreshTokens: async (accountKey) => {
    const { redis, key } = (await instance()).deps;
    for (const family of await redis.sMembers(key('acct', accountKey, 'families'))) {
      const familyKey = key('acct', accountKey, 'fam', family);
      for (const [id, value] of Object.entries(await redis.hGetAll(familyKey))) {
        await redis.hSet(familyKey, id, JSON.stringify({ ...JSON.parse(value), expiresAt: 0 }));
      }
    }
  },

  assetStored: async (roomKey, id) => {
    const { redis, key } = (await instance()).deps;
    const value = await redis.hGet(assetIndexOf(key, roomKey), id);
    if (!value) return null;
    const { type, size, uploadedAt } = JSON.parse(value) as {
      type: string;
      size: number;
      uploadedAt: number;
    };
    return { type, size, etag: `"${id}"`, uploadedAt };
  },

  block: async (id) => {
    await (await instance()).bucket.put(blockedKeyOf(id), new Uint8Array(), 'application/octet-stream');
  },

  banElsewhere: async (ban) => {
    const { redis, key } = (await instance()).deps;
    await redisModeration(redis, key).putBan(ban);
  },

  adminEpoch: async () => {
    const { redis, key } = (await instance()).deps;
    return redisModeration(redis, key).adminEpoch();
  },
};
