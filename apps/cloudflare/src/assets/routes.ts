import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AppEnv } from '../http/context';
import { fail } from '../http/errors';
import { networkOf } from '../http/network';
import { objectHeaders, remainingSeconds, setContentRange } from './response';
import { SNIFF_BYTES, sniff } from './sniff';
import type { AssetKind } from './sniff';

/** アセットの名前。中身の SHA-256 を小文字の16進で書いたもの */
const ASSET_ID = /^[0-9a-f]{64}$/;

const MEGA_BYTE = 1024 * 1024;

/** 種類ごとの上限。クライアントが読み込む上限（file-archiver.ts）と揃える */
export const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  image: 2 * MEGA_BYTE,
  audio: 10 * MEGA_BYTE,
};

const MAX_ANY_BYTES = Math.max(...Object.values(MAX_BYTES));

const networkOfRequest = (c: Context<AppEnv>): string =>
  networkOf(c.req.header('CF-Connecting-IP') ?? 'unknown');

/** すべての鍵でレート制限に収まっていれば true。どれか1つでも超えたら false */
const withinLimits = async (limiter: RateLimit, keys: string[]): Promise<boolean> => {
  const outcomes = await Promise.all(keys.map((key) => limiter.limit({ key })));
  return outcomes.every(({ success }) => success);
};

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const assetRoutes = new Hono<AppEnv>();

/** HEAD は R2 の head で答え、中身のストリームを開かない */
const headAsset = async (c: Context<AppEnv>, id: string) => {
  if (!(await withinLimits(c.env.READ_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  const object = await c.env.ASSETS.head(id);
  const remaining = object ? remainingSeconds(object, c.var.config.retentionSeconds) : 0;
  if (!object || remaining <= 0) return fail(c, 404, 'not-found');
  return new Response(null, { status: 200, headers: objectHeaders(object, remaining) });
};

// Hono は HEAD も GET の経路に回し、返した本文を捨てる。
assetRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  if (c.req.method === 'HEAD') return headAsset(c, id);

  // Worker が作った応答は CDN に残らないので、Cache API で同じデータセンターからの読み出しを受ける。
  // 条件付きリクエスト（304）と Range（206）は cache.match が答える。
  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return cached;

  if (!(await withinLimits(c.env.READ_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }
  // 条件付きリクエストと Range は R2 に任せる。条件が合わないと、R2 は本文の無いものを返す
  const headers = c.req.raw.headers;
  const object = await c.env.ASSETS.get(id, { onlyIf: headers, range: headers });
  const remaining = object ? remainingSeconds(object, c.var.config.retentionSeconds) : 0;
  if (!object || remaining <= 0) return fail(c, 404, 'not-found');

  const responseHeaders = objectHeaders(object, remaining);
  if (!('body' in object)) {
    if (headers.has('If-Match') || headers.has('If-Unmodified-Since')) {
      return fail(c, 412, 'precondition-failed');
    }
    responseHeaders.delete('Content-Length');
    return new Response(null, { status: 304, headers: responseHeaders });
  }
  if (headers.has('Range') && object.range) {
    setContentRange(responseHeaders, object.range, object.size);
    return new Response(object.body, { status: 206, headers: responseHeaders });
  }

  const response = new Response(object.body, { status: 200, headers: responseHeaders });
  c.executionCtx.waitUntil(cache.put(c.req.url, response.clone()));
  return response;
});

assetRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');

  const declared = Number(c.req.header('Content-Length'));
  if (!c.req.header('Content-Length') || !Number.isInteger(declared) || declared < 0) {
    return fail(c, 411, 'length-required');
  }
  if (declared > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  // 置いてあるものは数えずに答える。部屋を読み込むと、上がっている画像もまとめて送られてくるため
  const existing = await c.env.ASSETS.head(id);
  if (existing && remainingSeconds(existing, c.var.config.retentionSeconds) > 0) {
    return c.json({ id, status: 'exists' }, 200);
  }

  // IPv6 は /64 ごとに数える。アドレスを替えるだけでは増やせない
  if (!(await withinLimits(c.env.UPLOAD_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }

  const body = await c.req.arrayBuffer();
  const sniffed = sniff(new Uint8Array(body, 0, Math.min(SNIFF_BYTES, body.byteLength)));
  if (!sniffed) return fail(c, 415, 'unsupported-type');
  if (body.byteLength > MAX_BYTES[sniffed.kind]) return fail(c, 413, 'too-large');

  // 名前と中身が合わないものは置かない。R2 にもハッシュを渡し、書き込み側でも照合させる
  if (toHex(await crypto.subtle.digest('SHA-256', body)) !== id) {
    return fail(c, 400, 'hash-mismatch');
  }
  await c.env.ASSETS.put(id, body, { sha256: id, httpMetadata: { contentType: sniffed.type } });
  return c.json({ id, status: 'stored' }, 201);
});
