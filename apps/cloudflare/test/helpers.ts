import { exports } from 'cloudflare:workers';

export const ORIGIN = 'https://app.example';
export const BASE = 'https://backend.example/v1/assets';

export const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const OGG_HEAD = [0x4f, 0x67, 0x67, 0x53];

export const DAY_MS = 24 * 60 * 60 * 1000;

export const fileOf = (head: number[], size: number, seed = 0): Uint8Array => {
  const file = new Uint8Array(size);
  file.set(head);
  for (let i = head.length; i < size; i++) file[i] = (i * 31 + seed) & 0xff;
  return file;
};

export const sha256Hex = async (data: Uint8Array): Promise<string> =>
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

/** Worker を呼ぶ。送信元の IP を指定しなければ、毎回別の IP にする */
export const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', freshIp());
  return exports.default.fetch(new Request(`${BASE}/${path}`, { ...init, headers }));
};

export const put = (id: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  call(id, {
    method: 'PUT',
    body,
    headers: {
      Origin: ORIGIN,
      'Content-Length': String(body.byteLength),
      ...headers,
    },
  });
