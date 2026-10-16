import type { AddressInfo } from 'node:net';
import { afterAll } from 'vitest';
import { WebSocket } from 'ws';

import { parseServerConfig } from '../src/config/server.js';
import { blockedKeyOf } from '../src/core/assets/keys.js';
import { createApp } from '../src/http/app.js';
import { memoryBucket } from '../src/server/assets/bucket.js';
import { MAX_PUT_BYTES, assetIndexOf } from '../src/server/assets/backend.js';
import { backendProvider, upgrades } from '../src/server/deps.js';
import { createServer } from '../src/server/node.js';
import type { Harness, TestSocket } from './shared/harness-api.js';

// 共有のテストを、Node のサーバーと Redis の上で動かす。テストのファイルごとに、別の頭の Redis と
// メモリに置くアセットで、部屋のサーバーを1つ立てる

const ENV: Record<string, string | undefined> = {
  ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example,http://localhost:4200',
  DISCORD_CLIENT_ID: 'test-client',
  DISCORD_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  REDIS_KEY_PREFIX: `test:${crypto.randomUUID()}:`,
  BLOB_STORE_ID: 'memory',
};

const config = parseServerConfig(ENV);
/** 部屋のアセットを置くところ。直接上げる流れのテストが、ブラウザの代わりにここへ上げる */
export const bucket = memoryBucket();
const withoutLogin = new Set<string>();
/** 返したあとに続ける仕事。fetchWith は、これが終わるまで待ってから返す */
const deferred = new Set<Promise<unknown>>();
const provider = backendProvider({
  bucketOf: () => bucket,
  // テストでは上限を小さくして、429 を数回のリクエストで確かめる
  limits: { upload: 5, read: 5, room: 5, auth: 5 },
  withoutLogin,
  defer: (work) => {
    const tracked = work.catch(() => undefined).finally(() => deferred.delete(tracked));
    deferred.add(tracked);
  },
});

const appWith = (env: Record<string, string | undefined>) =>
  createApp({
    server: { env: () => env, backendFor: provider.backendFor, sweep: provider.sweep },
  });
const app = appWith(ENV);
const server = createServer(app.fetch, upgrades);
const port = new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});

// 部屋のサーバーは、テストの設定で先に作っておく。fetchWith がほかの設定で先に作ると、部屋がその設定で動く
await provider.backendFor(config);

const deps = async () => provider.depsFor(config) as NonNullable<ReturnType<typeof provider.depsFor>>;

// 終わりかけの仕事（振っているダイスなど）を待ち、部屋を放してから閉じる。テストのあとで書き残させない
afterAll(async () => {
  await Promise.all([...deferred]);
  const { runtime, redis } = await deps();
  await runtime.close();
  server.close();
  server.closeAllConnections();
  redis.destroy();
});

/** テストは送信元を CF-Connecting-IP に書く。Vercel では x-real-ip に入る */
const vercelHeaders = (headers: Headers): Headers => {
  const moved = new Headers(headers);
  const ip = moved.get('CF-Connecting-IP');
  if (ip) moved.set('x-real-ip', ip);
  return moved;
};

const forVercel = (request: Request): Request => new Request(request, { headers: vercelHeaders(request.headers) });

/** ws のクライアントを、テストの形にする。受ける側が付く前に届いたものは取っておく */
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
  // Blob は本文の上限を超えるものを直接上げさせられる。メモリの置き場所も同じにしてある
  assetUpload: { maxPutBytes: MAX_PUT_BYTES, directUpload: true },

  fetch: async (request) => app.fetch(forVercel(request)),

  fetchWith: async (request, overrides) => {
    const env = { ...ENV, ...overrides };
    const res = await appWith(env).fetch(forVercel(request));
    await Promise.all([...deferred]);
    return res;
  },

  upgrade: async (request) => {
    // WebSocket でない要求は、HTTP のまま送る
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      const res = await harness.fetch(request);
      return { status: res.status, socket: null, json: () => res.json() };
    }
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    vercelHeaders(request.headers).forEach((value, name) => {
      if (name !== 'upgrade') headers[name] = value;
    });
    const ws = new WebSocket(`ws://127.0.0.1:${await port}${url.pathname}${url.search}`, {
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
    (await deps()).runtime.withRoom(roomKey, (room) => run({ engine: room.engine as never, host: room as never })),

  createRoom: async (init) => (await provider.backendFor(config)).rooms.create(init),

  canUpload: async (roomKey, userId) => (await provider.backendFor(config)).rooms.canUpload(roomKey, userId),

  dropLogin: async (roomKey) => {
    withoutLogin.add(roomKey);
  },

  expireLoginCode: async (accountKey, id) => {
    const { redis, key } = await deps();
    await redis.hSet(key('acct', accountKey, 'code', id), 'expiresAt', '0');
  },

  expireRefreshTokens: async (accountKey) => {
    const { redis, key } = await deps();
    for (const family of await redis.sMembers(key('acct', accountKey, 'families'))) {
      const familyKey = key('acct', accountKey, 'fam', family);
      for (const [id, value] of Object.entries(await redis.hGetAll(familyKey))) {
        await redis.hSet(familyKey, id, JSON.stringify({ ...JSON.parse(value), expiresAt: 0 }));
      }
    }
  },

  assetStored: async (roomKey, id) => {
    const { redis, key } = await deps();
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
    await bucket.put(blockedKeyOf(id), new Uint8Array(), 'application/octet-stream');
  },
};
