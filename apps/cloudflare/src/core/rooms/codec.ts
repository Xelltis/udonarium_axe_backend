import { decode, encode } from '@msgpack/msgpack';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { ServerMessage } from '../../../contracts/protocol.js';

/** これより大きいフレームは gzip を試す。クライアントの SkyWay の送り方と揃える */
const COMPRESS_OVER_BYTES = 1024;

/**
 * 受けたフレームを展開したあとの上限。Durable Object が受けられる WebSocket のメッセージ（32MiB）と揃える。
 * 小さな gzip が大きく膨らむもので、メモリを使い切らせないため
 */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** 配列と map の要素数の上限。短いバイト列で大きな配列を作らせない */
const MAX_COLLECTION_LENGTH = 200_000;

const isGzip = (bytes: Uint8Array): boolean =>
  bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** 送るフレーム。MessagePack にし、1KiB を超えて gzip で縮むなら縮める */
export const encodeFrame = (message: ServerMessage): Uint8Array => {
  const bytes = encode(message);
  if (bytes.byteLength <= COMPRESS_OVER_BYTES) return bytes;
  const compressed = gzipSync(bytes);
  return compressed.byteLength < bytes.byteLength ? compressed : bytes;
};

/** 受けたフレームを読む。gzip ならまず展開する。読めなければ例外 */
export const decodeFrame = (frame: ArrayBuffer): unknown => {
  const bytes = new Uint8Array(frame);
  const plain = isGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: MAX_FRAME_BYTES }) : bytes;
  return decode(plain, {
    maxArrayLength: MAX_COLLECTION_LENGTH,
    maxMapLength: MAX_COLLECTION_LENGTH,
  });
};

/** SQLite に置く syncData のバイト列 */
export const encodeData = (data: unknown): ArrayBuffer => {
  const bytes = encode(data);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export const decodeData = (bytes: Uint8Array): unknown => decode(bytes);
