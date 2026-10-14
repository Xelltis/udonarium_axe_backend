import { Hono } from 'hono';
import type { Context } from 'hono';

import { isAllowedOrigin, parseAllowedOrigins } from '../http/origin';
import { SNIFF_BYTES, sniff } from './sniff';
import type { AssetKind } from './sniff';

interface AssetEnv {
  Bindings: Env;
}

/** アセットの名前。中身の SHA-256 を小文字の16進で書いたもの */
const ASSET_ID = /^[0-9a-f]{64}$/;

const MEGA_BYTE = 1024 * 1024;

/** 種類ごとの上限。クライアントが読み込む上限（file-archiver.ts）と揃える */
export const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  image: 2 * MEGA_BYTE,
  audio: 10 * MEGA_BYTE,
};

const MAX_ANY_BYTES = Math.max(...Object.values(MAX_BYTES));

/**
 * 配信のキャッシュ期間（7日）。中身は名前で決まるので古くならないが、
 * バケットの保持期間（30日）より長く CDN に残らないよう短めにする。
 */
const CACHE_CONTROL = 'public, max-age=604800, immutable';

const ALLOWED_METHODS = 'GET, HEAD, PUT, OPTIONS';

const fail = (
  c: Context<AssetEnv>,
  status: 400 | 403 | 404 | 411 | 413 | 415 | 429,
  error: string,
) => c.json({ error }, status);

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

const allowedOriginOf = (c: Context<AssetEnv>): string | null => {
  const origin = c.req.header('Origin');
  if (!origin) return null;
  return isAllowedOrigin(origin, parseAllowedOrigins(c.env.ACCESS_CONTROL_ALLOW_ORIGIN))
    ? origin
    : null;
};

const objectHeaders = (id: string, object: R2Object): Headers => {
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', `"${id}"`);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return headers;
};

export const assetRoutes = new Hono<AssetEnv>();

// GET と HEAD は誰にでも返す（中身は名前を知っている人にしか辿れない）。
// Origin で出し分けるとキャッシュに残った版がアプリから読めなくなるので、常に `*` を付ける。
// PUT と、そのプリフライトは許可した Origin からしか受けない。
assetRoutes.use('/:id', async (c, next) => {
  if (c.req.method !== 'PUT' && c.req.method !== 'OPTIONS') {
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    return;
  }
  const origin = allowedOriginOf(c);
  if (!origin) return fail(c, 403, 'origin-not-allowed');
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', origin);
  c.res.headers.append('Vary', 'Origin');
});

assetRoutes.options('/:id', (c) => {
  c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Max-Age', '86400');
  return c.body(null, 204);
});

assetRoutes.on('HEAD', '/:id', async (c) => {
  const id = c.req.param('id');
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  const object = await c.env.ASSETS.head(id);
  if (!object) return c.body(null, 404);
  return c.body(null, 200, Object.fromEntries(objectHeaders(id, object)));
});

assetRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  // 名前が中身のハッシュなので、ETag が合えば読まずに 304 を返せる
  if (c.req.header('If-None-Match') === `"${id}"`) {
    return c.body(null, 304, { ETag: `"${id}"`, 'Cache-Control': CACHE_CONTROL });
  }
  const object = await c.env.ASSETS.get(id);
  if (!object) return fail(c, 404, 'not-found');
  return c.body(object.body, 200, Object.fromEntries(objectHeaders(id, object)));
});

assetRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');

  const declared = Number(c.req.header('Content-Length'));
  if (!c.req.header('Content-Length') || !Number.isInteger(declared) || declared < 0) {
    return fail(c, 411, 'length-required');
  }
  if (declared > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  const { success } = await c.env.UPLOAD_LIMITER.limit({
    key: c.req.header('CF-Connecting-IP') ?? 'unknown',
  });
  if (!success) return fail(c, 429, 'rate-limited');

  if (await c.env.ASSETS.head(id)) return c.json({ id, status: 'exists' }, 200);

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
