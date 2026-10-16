import type { PeerRole } from '../../contracts/protocol.js';
import { roomAssetKey } from '../../src/core/assets/keys.js';
import {
  ACCESS_TOKEN_SECONDS,
  ASSET_TOKEN_SECONDS,
  signToken,
} from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';

export const ORIGIN = 'https://app.example';
/** アセットのテストで使う部屋。アセットの経路は部屋の Durable Object に尋ねないので、作らなくてよい */
export const ROOM_KEY = '0123456789abcdef0123456789abcdef';
export const OTHER_ROOM_KEY = 'fedcba9876543210fedcba9876543210';
export const BASE = `https://backend.example/v1/rooms/${ROOM_KEY}/assets`;

export const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const OGG_HEAD = [0x4f, 0x67, 0x67, 0x53];

export const DAY_MS = 24 * 60 * 60 * 1000;

/** テストの部屋のサーバーに置いた SESSION_SECRET と同じもの */
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** ログインした人のアクセストークン。userId を指定しなければ、同じ1人 */
export const accessTokenFor = (userId = 'uploader', seconds = ACCESS_TOKEN_SECONDS) =>
  signToken<'access'>(
    { aud: 'access', sub: `discord:${userId}`, uid: userId, name: userId },
    seconds,
    SESSION_SECRET,
  );

/** アセットを置く人。ROOM_KEY と OTHER_ROOM_KEY の部屋を作った GM */
export const UPLOADER = 'uploader';

/** 部屋のサーバーが席に渡す、部屋のアセットのトークン */
export const assetTokenFor = (
  role: PeerRole = 'pl',
  room = ROOM_KEY,
  seconds = ASSET_TOKEN_SECONDS,
  uid = UPLOADER,
) => signToken<'asset'>({ aud: 'asset', room, role, uid }, seconds, SESSION_SECRET);

/** ROOM_KEY の部屋に置いたアセットが、バケットで置かれる名前 */
export const storedKeyOf = (id: string) => roomAssetKey(ROOM_KEY, id);

/** 本文に使うバイト列。どの部屋のサーバーの型でも、Request の本文に渡せるもの */
export type Bytes = Uint8Array<ArrayBuffer>;

/** 文字列のバイト列 */
export const textOf = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

/** 応答の本文を、その形として読む */
export const jsonOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

export const fileOf = (head: number[], size: number, seed = 0): Bytes => {
  const file = new Uint8Array(size);
  file.set(head);
  for (let i = head.length; i < size; i++) file[i] = (i * 31 + seed) & 0xff;
  return file;
};

export const sha256Hex = async (data: Bytes): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

let seed = 0;
/** テストごとに別の中身にして、R2 とキャッシュに残ったものを混ぜない */
export const freshFile = async (head = PNG_HEAD, size = 256) => {
  const file = fileOf(head, size, ++seed);
  return { file, id: await sha256Hex(file) };
};

let lastIp = 0;
/** テストごとに別の IP にして、レート制限の数え方を混ぜない */
export const freshIp = () => `198.51.${Math.floor(++lastIp / 250)}.${lastIp % 250}`;

/**
 * ROOM_KEY の部屋のアセットを呼ぶ。指定しなければ、毎回別の IP から、許可した Origin の
 * ページとして、見学のトークンを付けて呼ぶ
 */
export const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', freshIp());
  if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
  if (!headers.has('Authorization'))
    headers.set('Authorization', `Bearer ${assetTokenFor('guest')}`);
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
 * 値の形。キーと値の型を並べたもの。配列は1つ目の形。null は文字列とみなす（契約で null になるのは、
 * 無いかもしれない文字列だけ）
 */
export const shapeOf = (value: unknown): unknown => {
  if (value === null) return 'string';
  if (Array.isArray(value)) return [shapeOf(value[0])];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item)]),
    );
  }
  return typeof value;
};
