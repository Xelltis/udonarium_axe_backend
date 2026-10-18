import type { PeerRole } from '../../contracts/protocol.js';
import { roomAssetKey } from '../../src/core/assets/keys.js';
import { ACCESS_TOKEN_SECONDS, ASSET_TOKEN_SECONDS, signToken } from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';

export const ORIGIN = 'https://app.example';
/** The room the asset tests use. The asset routes do not ask the room's Durable Object, so it need not be made. */
export const ROOM_KEY = '0123456789abcdef0123456789abcdef';
export const OTHER_ROOM_KEY = 'fedcba9876543210fedcba9876543210';
export const BASE = `https://backend.example/v1/rooms/${ROOM_KEY}/assets`;

export const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const OGG_HEAD = [0x4f, 0x67, 0x67, 0x53];

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The same SESSION_SECRET as the one set on the room server under test. */
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** The access token of a logged-in person. Without a userId, always the same person. */
export const accessTokenFor = (userId = 'uploader', seconds = ACCESS_TOKEN_SECONDS) =>
  signToken<'access'>({ aud: 'access', sub: `discord:${userId}`, uid: userId, name: userId }, seconds, SESSION_SECRET);

/** The person who stores assets. The GM who made the ROOM_KEY and OTHER_ROOM_KEY rooms. */
export const UPLOADER = 'uploader';

/** The room asset token the room server hands a seat. */
export const assetTokenFor = (role: PeerRole = 'pl', room = ROOM_KEY, seconds = ASSET_TOKEN_SECONDS, uid = UPLOADER) =>
  signToken<'asset'>({ aud: 'asset', room, role, uid }, seconds, SESSION_SECRET);

/** The name in the bucket of an asset stored in the ROOM_KEY room. */
export const storedKeyOf = (id: string) => roomAssetKey(ROOM_KEY, id);

/** Bytes for a body. They can be a Request's body under the types of any room server. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** The bytes of a string. */
export const textOf = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

/** Reads a response's body as the given shape. */
export const jsonOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

export const fileOf = (head: number[], size: number, seed = 0): Bytes => {
  const file = new Uint8Array(size);
  file.set(head);
  for (let i = head.length; i < size; i++) file[i] = (i * 31 + seed) & 0xff;
  return file;
};

export const sha256Hex = async (data: Bytes): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

let seed = 0;
/** Different contents for each test, so that what is left in R2 and the cache does not mix. */
export const freshFile = async (head = PNG_HEAD, size = 256) => {
  const file = fileOf(head, size, ++seed);
  return { file, id: await sha256Hex(file) };
};

let lastIp = 0;
/** A different IP for each test, so that the rate limit counts do not mix. */
export const freshIp = () => `198.51.${Math.floor(++lastIp / 250)}.${lastIp % 250}`;

/** The span of a rate limit's window in the tests (milliseconds). */
const RATE_WINDOW_MS = 60_000;

/**
 * Runs calls that count against a rate limit within one of its windows. The windows are aligned to
 * the wall clock, so calls that cross into the next one are counted afresh there; they are run once
 * more then, from a new address. `run` is handed the address to call from.
 */
export const withinOneWindow = async <T>(run: (ip: string) => Promise<T>): Promise<T> => {
  for (let tries = 0; ; tries++) {
    const window = Math.floor(Date.now() / RATE_WINDOW_MS);
    const result = await run(freshIp());
    if (tries > 0 || Math.floor(Date.now() / RATE_WINDOW_MS) === window) return result;
  }
};

/**
 * Calls an asset of the ROOM_KEY room. Unless told otherwise, it calls each time from a new IP, as a
 * page of an allowed Origin, with a guest's token.
 */
export const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', freshIp());
  if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${assetTokenFor('guest')}`);
  return harness.fetch(new Request(`${BASE}/${path}`, { ...init, headers }));
};

export const put = (id: string, body: Bytes, headers: Record<string, string> = {}) =>
  call(id, {
    method: 'PUT',
    body,
    headers: {
      Origin: ORIGIN,
      'Content-Length': String(body.byteLength),
      Authorization: `Bearer ${assetTokenFor('pl')}`,
      ...headers,
    },
  });

/**
 * The shape of a value: its keys with the types of their values. An array has the shape of its first
 * item. Null counts as a string (in the contract, only a string that may be missing is ever null).
 */
export const shapeOf = (value: unknown): unknown => {
  if (value === null) return 'string';
  if (Array.isArray(value)) return [shapeOf(value[0])];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item)])
    );
  }
  return typeof value;
};
