import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { MAX_BYTES } from '../src/assets/routes';

const ORIGIN = 'https://app.example';
const BASE = 'https://backend.example/v1/assets';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const OGG_HEAD = [0x4f, 0x67, 0x67, 0x53];

const fileOf = (head: number[], size: number, seed = 0): Uint8Array => {
  const file = new Uint8Array(size);
  file.set(head);
  for (let i = head.length; i < size; i++) file[i] = (i * 31 + seed) & 0xff;
  return file;
};

const sha256Hex = async (data: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

let lastIp = 0;
/** テストごとに別の IP にして、レート制限の数え方を混ぜない */
const freshIp = () => `203.0.113.${++lastIp}`;

const call = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`${BASE}/${path}`, init));

const put = (id: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  call(id, {
    method: 'PUT',
    body,
    headers: {
      Origin: ORIGIN,
      'Content-Length': String(body.byteLength),
      'CF-Connecting-IP': freshIp(),
      ...headers,
    },
  });

describe('PUT /v1/assets/:id', () => {
  it('stores bytes under their own hash, with the type read from the bytes', async () => {
    const file = fileOf(PNG_HEAD, 1024);
    const id = await sha256Hex(file);

    const res = await put(id, file, { 'Content-Type': 'text/plain' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id, status: 'stored' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const stored = await env.ASSETS.get(id);
    expect(stored?.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(file);
  });

  it('answers 200 without writing again when the asset is already there', async () => {
    const file = fileOf(PNG_HEAD, 256);
    const id = await sha256Hex(file);
    await put(id, file);
    const before = await env.ASSETS.head(id);

    const res = await put(id, file);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: 'exists' });
    expect((await env.ASSETS.head(id))?.uploaded).toEqual(before?.uploaded);
  });

  it('turns away bytes whose hash is not the name, and stores nothing', async () => {
    const file = fileOf(PNG_HEAD, 256);
    const wrongId = await sha256Hex(fileOf(PNG_HEAD, 256, 1));

    const res = await put(wrongId, file);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'hash-mismatch' });
    expect(await env.ASSETS.head(wrongId)).toBeNull();
  });

  it.each(['abc', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63)])(
    'turns away the name %s',
    async (id) => {
      const res = await put(id, fileOf(PNG_HEAD, 64));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-id' });
    },
  );

  it('turns away a file that is neither a picture nor a sound', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const res = await put(await sha256Hex(svg), svg);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported-type' });
  });

  it('holds a picture to the picture limit and a sound to the sound limit', async () => {
    const bigPicture = fileOf(PNG_HEAD, MAX_BYTES.image + 1);
    const bigSound = fileOf(OGG_HEAD, MAX_BYTES.image + 1);

    const picture = await put(await sha256Hex(bigPicture), bigPicture);
    const sound = await put(await sha256Hex(bigSound), bigSound);

    expect(picture.status).toBe(413);
    expect(await picture.json()).toEqual({ error: 'too-large' });
    expect(sound.status).toBe(201);
  });

  it('turns away a declared length over every limit before reading the body', async () => {
    const file = fileOf(OGG_HEAD, 64);
    const res = await put(await sha256Hex(file), file, {
      'Content-Length': String(MAX_BYTES.audio + 1),
    });
    expect(res.status).toBe(413);
  });

  it('asks for a length when the body is streamed without one', async () => {
    const file = fileOf(PNG_HEAD, 64);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(file);
        controller.close();
      },
    });
    const res = await call(await sha256Hex(file), {
      method: 'PUT',
      body: streamed,
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp() },
    });
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ error: 'length-required' });
  });

  it.each([
    ['no Origin', undefined],
    ['an Origin not on the list', 'https://elsewhere.example'],
  ])('refuses an upload with %s', async (_name, origin) => {
    const file = fileOf(PNG_HEAD, 64);
    const headers: Record<string, string> = {
      'Content-Length': String(file.byteLength),
      'CF-Connecting-IP': freshIp(),
    };
    if (origin) headers['Origin'] = origin;

    const res = await call(await sha256Hex(file), { method: 'PUT', body: file, headers });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin-not-allowed' });
  });

  it('stops one address once it has uploaded its share', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let seed = 0; seed < 6; seed++) {
      const file = fileOf(PNG_HEAD, 64, seed + 100);
      statuses.push((await put(await sha256Hex(file), file, { 'CF-Connecting-IP': ip })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('GET and HEAD /v1/assets/:id', () => {
  it('hands the stored bytes to anyone, readable from any page', async () => {
    const file = fileOf(OGG_HEAD, 512);
    const id = await sha256Hex(file);
    await put(id, file);

    const res = await call(id);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    expect(res.headers.get('Content-Type')).toBe('audio/ogg');
    expect(res.headers.get('Content-Length')).toBe('512');
    expect(res.headers.get('ETag')).toBe(`"${id}"`);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=604800, immutable');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('tells whether an asset is there without sending it', async () => {
    const file = fileOf(PNG_HEAD, 300);
    const id = await sha256Hex(file);
    const missing = await call(id, { method: 'HEAD' });
    await put(id, file);

    const present = await call(id, { method: 'HEAD' });

    expect(missing.status).toBe(404);
    expect(present.status).toBe(200);
    expect(present.headers.get('Content-Length')).toBe('300');
    expect(present.headers.get('Content-Type')).toBe('image/png');
    expect(await present.text()).toBe('');
  });

  it('answers 304 to a request that already holds the asset', async () => {
    const id = 'a'.repeat(64);
    const res = await call(id, { headers: { 'If-None-Match': `"${id}"` } });
    expect(res.status).toBe(304);
  });

  it('answers 404 for an asset that is not there and 400 for a bad name', async () => {
    expect((await call('b'.repeat(64))).status).toBe(404);
    expect((await call('not-a-hash')).status).toBe(400);
  });
});

describe('OPTIONS /v1/assets/:id', () => {
  it('lets a listed page send an upload', async () => {
    const res = await call('c'.repeat(64), {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('refuses a page that is not listed', async () => {
    const res = await call('c'.repeat(64), {
      method: 'OPTIONS',
      headers: { Origin: 'https://elsewhere.example', 'Access-Control-Request-Method': 'PUT' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
