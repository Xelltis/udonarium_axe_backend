import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';

import app from '../src/index';

import { blockedKeyOf, roomAssetKey } from '../src/core/assets/keys';
import type { RoomEngine } from '../src/core/rooms/engine';
import type { RoomHost } from '../src/core/rooms/host';
import type { RoomDurableObject } from '../src/rooms/room';
import type { Harness, TestSocket } from './shared/harness-api';

// 共有のテストを、Worker と Durable Object の上で動かす

const room = (roomKey: string) => env.ROOMS.getByName(roomKey);

/** Worker が返した WebSocket を受け、テストの形にする */
const socketOf = (ws: WebSocket): TestSocket => {
  // 新しい互換日付では、バイナリは Blob で届くのが標準になった
  ws.binaryType = 'arraybuffer';
  ws.accept();
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onMessage: (listener) => ws.addEventListener('message', (event) => listener(event.data as ArrayBuffer | string)),
    onClose: (listener) => ws.addEventListener('close', (event) => listener(event.code, event.reason)),
  };
};

export const harness: Harness = {
  // 1回の PUT で、種類ごとの上限まで置ける
  assetUpload: null,

  fetch: (request) => exports.default.fetch(request),

  fetchWith: async (request, overrides) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(request, { ...env, ...overrides } as Env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  },

  upgrade: async (request) => {
    const res = await exports.default.fetch(request);
    return {
      status: res.status,
      socket: res.webSocket ? socketOf(res.webSocket) : null,
      json: () => res.json(),
    };
  },

  inside: (roomKey, run) =>
    runInDurableObject(room(roomKey), (instance: RoomDurableObject) =>
      run({
        engine: (instance as unknown as { engine: RoomEngine<object> }).engine,
        host: instance as unknown as RoomHost<object>,
      })
    ),

  createRoom: (init) => room(init.roomKey).create(init),

  canUpload: (roomKey, userId) => room(roomKey).canUpload(userId),

  assetStored: async (roomKey, id) => {
    const object = await env.ASSETS.head(roomAssetKey(roomKey, id));
    return object
      ? {
          type: object.httpMetadata?.contentType,
          size: object.size,
          etag: object.httpEtag,
          uploadedAt: object.uploaded.getTime(),
        }
      : null;
  },

  block: async (id) => {
    await env.ASSETS.put(blockedKeyOf(id), new Uint8Array());
  },

  expireLoginCode: (accountKey, id) =>
    runInDurableObject(env.ACCOUNTS.getByName(accountKey), (_instance, state) => {
      state.storage.sql.exec('UPDATE login_codes SET expires_at = 0 WHERE id = ?', id);
    }),

  expireRefreshTokens: (accountKey) =>
    runInDurableObject(env.ACCOUNTS.getByName(accountKey), (_instance, state) => {
      state.storage.sql.exec('UPDATE refresh_tokens SET expires_at = 0');
    }),

  dropLogin: (roomKey) =>
    runInDurableObject(room(roomKey), (instance: RoomDurableObject) => {
      (instance as unknown as { env: Env }).env = {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
      } as Env;
    }),
};
