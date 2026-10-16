import { decode, encode } from '@msgpack/msgpack';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { ServerMessage } from '../../../contracts/protocol.js';

/** Frames bigger than this are tried with gzip. Kept the same as how the client sends over SkyWay. */
const COMPRESS_OVER_BYTES = 1024;

/**
 * The limit on a received frame after it is unpacked. Kept the same as the WebSocket message a
 * Durable Object can take (32MiB).
 * It is there so that a small gzip that swells into something huge cannot use up the memory.
 */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** The limit on the number of items in an array or a map. Keeps a few bytes from making a huge array. */
const MAX_COLLECTION_LENGTH = 200_000;

const isGzip = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** A frame to send. In MessagePack, and gzipped when it is over 1KiB and gzip makes it smaller. */
export const encodeFrame = (message: ServerMessage): Uint8Array => {
  const bytes = encode(message);
  if (bytes.byteLength <= COMPRESS_OVER_BYTES) return bytes;
  const compressed = gzipSync(bytes);
  return compressed.byteLength < bytes.byteLength ? compressed : bytes;
};

/** Reads a received frame. Unpacks it first when it is gzip. Throws when it cannot be read. */
export const decodeFrame = (frame: ArrayBuffer | Uint8Array): unknown => {
  const bytes = new Uint8Array(frame);
  const plain = isGzip(bytes) ? gunzipSync(bytes, { maxOutputLength: MAX_FRAME_BYTES }) : bytes;
  return decode(plain, {
    maxArrayLength: MAX_COLLECTION_LENGTH,
    maxMapLength: MAX_COLLECTION_LENGTH,
  });
};

/** The bytes of syncData to store in SQLite. */
export const encodeData = (data: unknown): ArrayBuffer => {
  const bytes = encode(data);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export const decodeData = (bytes: Uint8Array): unknown => decode(bytes);
