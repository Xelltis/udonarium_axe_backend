import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';

import type { AppEnv } from './context';
import { fail } from './errors';
import { isAllowedOrigin } from './origin';

const MAX_AGE_SECONDS = 86_400;

// 読み出し（GET と HEAD）は誰にでも返す（中身は名前を知っている人にしか辿れない）。
// Origin で出し分けるとキャッシュに残った版がアプリから読めなくなるので、常に `*` を付ける。
// プリフライトでは求められたヘッダー（Range や If-None-Match など）をそのまま許す。
const readCors = cors({ origin: '*', allowMethods: ['GET', 'HEAD'], maxAge: MAX_AGE_SECONDS });

// 書き込み（PUT）の Origin は assetCors で確かめ済みなので、そのまま echo する
const writeCors = cors({
  origin: (origin) => origin,
  allowMethods: ['PUT'],
  allowHeaders: ['Content-Type'],
  maxAge: MAX_AGE_SECONDS,
});

const WRITE_METHODS = new Set(['PUT']);

/** 実際のリクエストならそのメソッド、プリフライトなら許可を求められているメソッド */
const intendedMethodOf = (c: Context): string | undefined =>
  c.req.method === 'OPTIONS' ? c.req.header('Access-Control-Request-Method') : c.req.method;

/**
 * 書き込みは許可した Origin からしか受けない。プリフライトも含めて 403 で断る。
 * 読み出しとそのプリフライトは、どのページからでも通す。
 */
export const assetCors = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const method = intendedMethodOf(c);
  if (!method || !WRITE_METHODS.has(method)) return readCors(c, next);
  if (!isAllowedOrigin(c.req.header('Origin'), c.var.config.allowedOrigins)) {
    return fail(c, 403, 'origin-not-allowed');
  }
  return writeCors(c, next);
};
