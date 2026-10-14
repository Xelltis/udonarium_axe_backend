import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AppEnv } from '../http/context';
import { fail } from '../http/errors';
import { networkOf } from '../http/network';
import { objectHeaders, remainingSeconds, setContentRange } from './response';
import { SNIFF_BYTES, sniff } from './sniff';
import type { AssetKind } from './sniff';
import { randomStart, sweepExpired } from './sweep';

/** アセットの名前。中身の SHA-256 を小文字の16進で書いたもの */
const ASSET_ID = /^[0-9a-f]{64}$/;

const MEGA_BYTE = 1024 * 1024;

/** 種類ごとの上限。クライアントが読み込む上限（file-archiver.ts）と揃える */
export const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  image: 2 * MEGA_BYTE,
  audio: 10 * MEGA_BYTE,
};

const MAX_ANY_BYTES = Math.max(...Object.values(MAX_BYTES));

/** R2 が sha256 の照合に失敗したときのエラー番号 */
const R2_BAD_DIGEST = '(10037)';

/**
 * 置いたあとに、期限切れのものを掃除する割合。バケットはアップロードでしか増えないので、
 * アップロードに比例して掃除すれば、ライフサイクル規則を作らなくても増え続けない
 */
const SWEEP_CHANCE = 1 / 20;

const networkOfRequest = (c: Context<AppEnv>): string =>
  networkOf(c.req.header('CF-Connecting-IP') ?? 'unknown');

/**
 * すべての鍵でレート制限に収まっていれば true。どれか1つでも超えたら false。
 *
 * namespace_id は同じアカウントの Worker どうしで共有されるので、鍵の頭に受けたホスト名を付けて、
 * 同じアカウントに置いた別のインスタンスと数えるものを混ぜない。
 */
const withinLimits = async (
  c: Context<AppEnv>,
  limiter: RateLimit,
  keys: string[],
): Promise<boolean> => {
  const host = new URL(c.req.url).host;
  const outcomes = await Promise.all(keys.map((key) => limiter.limit({ key: `${host}/${key}` })));
  return outcomes.every(({ success }) => success);
};

/** Content-Length の値。無いか、0 以上の整数でなければ null */
const declaredLengthOf = (c: Context<AppEnv>): number | null => {
  const header = c.req.header('Content-Length');
  const length = Number(header);
  return header && Number.isInteger(length) && length >= 0 ? length : null;
};

/** ストリームの先頭を、size バイト以上（足りなければ最後まで）読む */
const readHead = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  size: number,
): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < size) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  return chunks;
};

/** 先に読んだ chunks と、reader の残りを1本のストリームに戻す */
const rejoin = (
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });

export const assetRoutes = new Hono<AppEnv>();

/** HEAD は R2 の head で答え、中身のストリームを開かない */
const headAsset = async (c: Context<AppEnv>, id: string) => {
  if (!(await withinLimits(c, c.env.READ_LIMITER, [networkOfRequest(c)]))) {
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

  if (!(await withinLimits(c, c.env.READ_LIMITER, [networkOfRequest(c)]))) {
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

  const length = declaredLengthOf(c);
  if (length === null) return fail(c, 411, 'length-required');
  if (length > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  // 置いてあるものは数えずに答える。部屋を読み込むと、上がっている画像もまとめて送られてくるため
  const existing = await c.env.ASSETS.head(id);
  if (existing && remainingSeconds(existing, c.var.config.retentionSeconds) > 0) {
    return c.json({ id, status: 'exists' }, 200);
  }

  // IPv6 は /64 ごとに数える。アドレスを替えるだけでは増やせない
  if (!(await withinLimits(c, c.env.UPLOAD_LIMITER, [networkOfRequest(c)]))) {
    return fail(c, 429, 'rate-limited');
  }

  // 種類は先頭だけ読んで決め、残りは読み溜めずにそのまま R2 へ流す
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 415, 'unsupported-type');
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(
    new Uint8Array(await new Blob(head).arrayBuffer()).subarray(0, SNIFF_BYTES),
  );
  if (!sniffed) return fail(c, 415, 'unsupported-type');
  if (length > MAX_BYTES[sniffed.kind]) return fail(c, 413, 'too-large');

  // 名前と中身が合わないものは置かない。照合は R2 が書き込みながら行う
  const body = rejoin(head, reader).pipeThrough(new FixedLengthStream(length));
  try {
    await c.env.ASSETS.put(id, body, { sha256: id, httpMetadata: { contentType: sniffed.type } });
  } catch (err) {
    if (err instanceof Error && err.message.includes(R2_BAD_DIGEST)) {
      return fail(c, 400, 'hash-mismatch');
    }
    throw err;
  }
  if (Math.random() < SWEEP_CHANCE) {
    c.executionCtx.waitUntil(
      sweepExpired(c.env.ASSETS, c.var.config.retentionSeconds, randomStart()),
    );
  }
  return c.json({ id, status: 'stored' }, 201);
});
