import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_BYTES } from '../../src/core/assets/limits.js';
import { SNIFF_BYTES } from '../../src/core/assets/sniff.js';
import { harness } from '../harness.js';
import {
  BASE,
  OGG_HEAD,
  ORIGIN,
  OTHER_ROOM_KEY,
  PNG_HEAD,
  ROOM_KEY,
  accessTokenFor,
  assetTokenFor,
  call,
  fileOf,
  freshFile,
  freshIp,
  put,
  sha256Hex,
  jsonOf,
  textOf,
} from './helpers.js';
import { prepareAssetRooms } from './room-helpers.js';

beforeAll(prepareAssetRooms);

// 部屋のアセット。置き場所は部屋ごとに分かれ、読むのも置くのも、部屋のサーバーが席に渡した
// トークンを持つ人だけ。置けるのは GM と PL

const WEEK_SECONDS = 7 * 24 * 60 * 60;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 部屋の鍵の形が違うものも含めて、どこかの部屋のアセットの URL */
const urlIn = (roomKey: string, id: string) =>
  `https://backend.example/v1/rooms/${roomKey}/assets/${id}`;

describe('PUT /v1/rooms/:roomKey/assets/:id', () => {
  it('stores bytes under their own hash in the room, with the type read from the bytes', async () => {
    const { file, id } = await freshFile(PNG_HEAD, 1024);

    const res = await put(id, file, { 'Content-Type': 'text/plain' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id, status: 'stored' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toContain('Origin');
    expect((await harness.assetStored(ROOM_KEY, id))?.type).toBe('image/png');
    expect(new Uint8Array(await (await call(id)).arrayBuffer())).toEqual(file);
  });

  it('takes uploads from the GM too', async () => {
    const { file, id } = await freshFile();

    const res = await put(id, file, { Authorization: `Bearer ${assetTokenFor('gm')}` });

    expect(res.status).toBe(201);
  });

  it('answers 200 without writing again or counting, when the asset is already in the room', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const before = await harness.assetStored(ROOM_KEY, id);
    const ip = freshIp();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await put(id, file, { 'CF-Connecting-IP': ip });
      statuses.push(res.status);
      expect(await res.json()).toEqual({ id, status: 'exists' });
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await harness.assetStored(ROOM_KEY, id))?.uploadedAt).toBe(before?.uploadedAt);
  });

  it('keeps each room apart, so the same bytes go up again in another room', async () => {
    const { file, id } = await freshFile();
    await put(id, file);

    const res = await harness.fetch(
      new Request(urlIn(OTHER_ROOM_KEY, id), {
        method: 'PUT',
        body: file,
        headers: {
          Origin: ORIGIN,
          'Content-Length': String(file.byteLength),
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${assetTokenFor('pl', OTHER_ROOM_KEY)}`,
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(await harness.assetStored(OTHER_ROOM_KEY, id)).not.toBeNull();
  });

  it('turns away bytes whose hash is not the name, and stores nothing', async () => {
    const { file } = await freshFile();
    const { id: wrongId } = await freshFile();

    const res = await put(wrongId, file);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'hash-mismatch' });
    expect(await harness.assetStored(ROOM_KEY, wrongId)).toBeNull();
  });

  it.each(['abc', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63)])(
    'turns away the name %s',
    async (id) => {
      const res = await put(id, fileOf(PNG_HEAD, 64));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-id' });
    },
  );

  it('turns away a room key that cannot be one', async () => {
    const { file, id } = await freshFile();

    const res = await harness.fetch(
      new Request(urlIn('not-a-room', id), {
        method: 'PUT',
        body: file,
        headers: { Origin: ORIGIN, 'Content-Length': String(file.byteLength) },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-id' });
  });

  it.each([
    ['no token', ''],
    ['a token that ran out', `Bearer ${assetTokenFor('pl', ROOM_KEY, -1)}`],
    ['a token for another room', `Bearer ${assetTokenFor('pl', OTHER_ROOM_KEY)}`],
    ['a login token rather than the room’s', `Bearer ${accessTokenFor()}`],
    ['a token that is not Bearer', `Basic ${assetTokenFor('pl')}`],
  ])('asks for the room’s asset token, refusing %s', async (_name, authorization) => {
    const { file, id } = await freshFile();

    const res = await put(id, file, { Authorization: authorization });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'asset-token-required' });
    expect(await harness.assetStored(ROOM_KEY, id)).toBeNull();
  });

  it('keeps a guest from putting anything up', async () => {
    const { file, id } = await freshFile();

    const res = await put(id, file, { Authorization: `Bearer ${assetTokenFor('guest')}` });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not-a-player' });
    expect(await harness.assetStored(ROOM_KEY, id)).toBeNull();
  });

  it('keeps no assets on a Worker without login, where there are no rooms', async () => {
    const { file, id } = await freshFile();

    const res = await harness.fetchWith(
      new Request(`${BASE}/${id}`, {
        method: 'PUT',
        body: file,
        headers: {
          Origin: ORIGIN,
          'Content-Length': String(file.byteLength),
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${assetTokenFor('pl')}`,
        },
      }),
      { DISCORD_CLIENT_ID: undefined, DISCORD_CLIENT_SECRET: undefined, SESSION_SECRET: undefined },
    );

    expect(res.status).toBe(401);
  });

  it('refuses again what was taken down, in any room, under its marker', async () => {
    const { file, id } = await freshFile();
    await harness.block(id);

    const res = await put(id, file);

    expect(res.status).toBe(451);
    expect(await res.json()).toEqual({ error: 'blocked' });
    expect(await harness.assetStored(ROOM_KEY, id)).toBeNull();
  });

  it('turns away a file that is neither a picture nor a sound', async () => {
    const html = textOf('<!DOCTYPE html><html><script>alert(1)</script></html>');
    const res = await put(await sha256Hex(html), html);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported-type' });
  });

  it('stores an SVG longer than the part it reads to tell the type', async () => {
    const svg = textOf(
      `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(2000)}</svg>`,
    );
    const id = await sha256Hex(svg);

    const res = await put(id, svg);

    expect(res.status).toBe(201);
    expect((await harness.assetStored(ROOM_KEY, id))?.type).toBe('image/svg+xml');
    expect(new Uint8Array(await (await call(id)).arrayBuffer())).toEqual(svg);
  });

  it('turns away an SVG whose root comes after the part it reads', async () => {
    const svg = textOf(`<!--${'-'.repeat(SNIFF_BYTES)}--><svg></svg>`);
    const res = await put(await sha256Hex(svg), svg);
    expect(res.status).toBe(415);
  });

  it.each([
    ['an empty body', (req: Request) => harness.fetch(req)],
    ['no body at all', (req: Request) => harness.fetchWith(req, {})],
  ])('turns away an upload with %s', async (_name, send) => {
    const req = new Request(`${BASE}/${'0'.repeat(64)}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        'Content-Length': '0',
        'CF-Connecting-IP': freshIp(),
        Authorization: `Bearer ${assetTokenFor('pl')}`,
      },
    });
    const res = await send(req);
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
    const { file, id } = await freshFile(OGG_HEAD, 64);
    const res = await put(id, file, { 'Content-Length': String(MAX_BYTES.audio + 1) });
    expect(res.status).toBe(413);
  });

  it('asks for a length when the body is streamed without one', async () => {
    const { file, id } = await freshFile(PNG_HEAD, 64);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(file);
        controller.close();
      },
    });
    const res = await call(id, { method: 'PUT', body: streamed });
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ error: 'length-required' });
  });

  it.each([
    ['no Origin', ''],
    ['an Origin not on the list', 'https://elsewhere.example'],
  ])('refuses an upload with %s', async (_name, origin) => {
    const { file, id } = await freshFile(PNG_HEAD, 64);

    const res = await harness.fetch(
      new Request(`${BASE}/${id}`, {
        method: 'PUT',
        body: file,
        headers: {
          ...(origin ? { Origin: origin } : {}),
          'Content-Length': String(file.byteLength),
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${assetTokenFor('pl')}`,
        },
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin-not-allowed' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  describe('rate limit', () => {
    const uploadSix = async (headersOf: (i: number) => Record<string, string>) => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const { file, id } = await freshFile(PNG_HEAD, 64);
        statuses.push((await put(id, file, headersOf(i))).status);
      }
      return statuses;
    };

    it('stops one address once it has uploaded its share', async () => {
      const ip = freshIp();
      expect(await uploadSix(() => ({ 'CF-Connecting-IP': ip }))).toEqual([
        201, 201, 201, 201, 201, 429,
      ]);
    });

    it('counts every IPv6 address in a /64 as one sender', async () => {
      const statuses = await uploadSix((i) => ({ 'CF-Connecting-IP': `2001:db8:1:2::${i + 1}` }));
      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    });

    it('counts apart from another instance on the same account', async () => {
      const ip = freshIp();
      const statuses = await uploadSix(() => ({ 'CF-Connecting-IP': ip }));
      const { file, id } = await freshFile(PNG_HEAD, 64);
      const elsewhere = await harness.fetch(
        new Request(`https://other-instance.example/v1/rooms/${ROOM_KEY}/assets/${id}`, {
          method: 'PUT',
          body: file,
          headers: {
            Origin: ORIGIN,
            'Content-Length': String(file.byteLength),
            'CF-Connecting-IP': ip,
            Authorization: `Bearer ${assetTokenFor('pl')}`,
          },
        }),
      );

      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
      expect(elsewhere.status).toBe(201);
    });
  });
});

describe('GET /v1/rooms/:roomKey/assets/:id', () => {
  it('hands the stored bytes to whoever holds the room’s token, a guest too', async () => {
    const { file, id } = await freshFile(OGG_HEAD, 512);
    await put(id, file);

    const res = await call(id);

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    expect(res.headers.get('Content-Type')).toBe('audio/ogg');
    expect(res.headers.get('Content-Length')).toBe('512');
    expect(res.headers.get('ETag')).toBe((await harness.assetStored(ROOM_KEY, id))?.etag);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('names what it hands back by the name it was put up under, and lets the page read it', async () => {
    const named = await freshFile(PNG_HEAD, 300);
    const unnamed = await freshFile(PNG_HEAD, 310);
    await put(named.id, named.file, { 'X-Asset-Name': encodeURIComponent('ドラゴン.png') });
    await put(unnamed.id, unnamed.file);

    for (const method of ['GET', 'HEAD']) {
      const res = await call(named.id, { method });
      expect(decodeURIComponent(res.headers.get('X-Asset-Name') ?? '')).toBe('ドラゴン.png');
      expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Asset-Name');
      expect((await call(unnamed.id, { method })).headers.get('X-Asset-Name')).toBeNull();
    }
  });

  it('lets the browser keep a copy, but no cache it shares with others', async () => {
    const { file, id } = await freshFile();
    await put(id, file);

    const res = await call(id);

    expect(res.headers.get('Cache-Control')).toBe(`private, max-age=${WEEK_SECONDS}, immutable`);
  });

  it.each([
    ['no token', ''],
    ['a token that ran out', `Bearer ${assetTokenFor('guest', ROOM_KEY, -1)}`],
    ['a token for another room', `Bearer ${assetTokenFor('gm', OTHER_ROOM_KEY)}`],
  ])('hands nothing to %s', async (_name, authorization) => {
    const { file, id } = await freshFile();
    await put(id, file);
    await call(id);

    const res = await call(id, { headers: { Authorization: authorization } });
    const head = await call(id, { method: 'HEAD', headers: { Authorization: authorization } });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'asset-token-required' });
    expect(head.status).toBe(401);
  });

  it('finds nothing of one room under another room', async () => {
    const { file, id } = await freshFile();
    await put(id, file);

    const res = await harness.fetch(
      new Request(urlIn(OTHER_ROOM_KEY, id), {
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${assetTokenFor('gm', OTHER_ROOM_KEY)}`,
        },
      }),
    );

    expect(res.status).toBe(404);
  });

  it('refuses a page that is not listed', async () => {
    const { file, id } = await freshFile();
    await put(id, file);

    const res = await call(id, { headers: { Origin: 'https://elsewhere.example' } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin-not-allowed' });
  });

  it('serves an SVG in a sandbox, so a script inside it cannot run', async () => {
    const svg = textOf(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>',
    );
    const id = await sha256Hex(svg);
    await put(id, svg);

    const res = await call(id);
    const head = await call(id, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    for (const response of [res, head]) {
      const policy = response.headers.get('Content-Security-Policy') ?? '';
      expect(policy.split(';').map((directive) => directive.trim())).toEqual(
        expect.arrayContaining(["default-src 'none'", 'sandbox']),
      );
    }
  });

  it.each([
    ['its ETag', (etag: string) => etag],
    ['its weak ETag', (etag: string) => `W/${etag}`],
    ['a list holding its ETag', (etag: string) => `"other", ${etag}`],
    ['*', () => '*'],
  ])('answers 304 to a request holding %s', async (_name, ifNoneMatch) => {
    const { file, id } = await freshFile();
    await put(id, file);
    const etag = (await harness.assetStored(ROOM_KEY, id))?.etag ?? '';

    const res = await call(id, { headers: { 'If-None-Match': ifNoneMatch(etag) } });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('ETag')).toBe(etag);
    expect(res.headers.get('Cache-Control')).toBe(`private, max-age=${WEEK_SECONDS}, immutable`);
  });

  it('answers 404, not 304, when the asset the browser holds is gone', async () => {
    const { id } = await freshFile();
    const res = await call(id, { headers: { 'If-None-Match': `"${id}"` } });
    expect(res.status).toBe(404);
  });

  it('answers 412 when the asset does not match If-Match', async () => {
    const { file, id } = await freshFile();
    await put(id, file);

    const res = await call(id, { headers: { 'If-Match': '"other"' } });

    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: 'precondition-failed' });
  });

  it('answers a byte range with 206', async () => {
    const { file, id } = await freshFile(OGG_HEAD, 100);
    await put(id, file);

    const res = await call(id, { headers: { Range: 'bytes=10-19' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(file.subarray(10, 20));
  });

  it('stops one address once it has read its share from R2', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { id } = await freshFile();
      statuses.push((await call(id, { headers: { 'CF-Connecting-IP': ip } })).status);
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
  });

  it('answers 404 for an asset that is not there, and 400 for a bad name or room', async () => {
    const { id } = await freshFile();
    const missing = await call(id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not-found' });
    expect((await call('not-a-hash')).status).toBe(400);
    const badRoom = await harness.fetch(
      new Request(urlIn('not-a-room', id), { headers: { Origin: ORIGIN } }),
    );
    expect(badRoom.status).toBe(400);
  });
});

describe('HEAD /v1/rooms/:roomKey/assets/:id', () => {
  it('tells whether an asset is in the room without sending it', async () => {
    const { file, id } = await freshFile(PNG_HEAD, 300);
    const missing = await call(id, { method: 'HEAD' });
    await put(id, file);

    const present = await call(id, { method: 'HEAD' });

    expect(missing.status).toBe(404);
    expect(present.status).toBe(200);
    expect(present.headers.get('Content-Length')).toBe('300');
    expect(present.headers.get('Content-Type')).toBe('image/png');
    expect(present.headers.get('Cache-Control')).toBe(
      `private, max-age=${WEEK_SECONDS}, immutable`,
    );
    expect(present.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await present.text()).toBe('');
  });

  it('answers 404 to a browser holding an asset that is gone', async () => {
    const { id } = await freshFile();
    const res = await call(id, { method: 'HEAD', headers: { 'If-None-Match': `"${id}"` } });
    expect(res.status).toBe(404);
  });

  it('stops one address once it has asked R2 its share', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { id } = await freshFile();
      const res = await call(id, { method: 'HEAD', headers: { 'CF-Connecting-IP': ip } });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
  });
});

describe('GET /v1/rooms/:roomKey/assets', () => {
  const list = (headers: Record<string, string> = {}, roomKey = ROOM_KEY) =>
    harness.fetch(
      new Request(`https://backend.example/v1/rooms/${roomKey}/assets`, {
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${assetTokenFor('guest', roomKey)}`,
          ...headers,
        },
      }),
    );

  it('lists what is in the room, with the names they were put up under', async () => {
    const named = await freshFile(PNG_HEAD, 100);
    const unnamed = await freshFile(OGG_HEAD, 120);
    const garbled = await freshFile(PNG_HEAD, 140);
    const long = await freshFile(PNG_HEAD, 160);
    await put(named.id, named.file, { 'X-Asset-Name': encodeURIComponent('ドラゴン.png') });
    await put(unnamed.id, unnamed.file);
    await put(garbled.id, garbled.file, { 'X-Asset-Name': '%E3%81' });
    await put(long.id, long.file, { 'X-Asset-Name': 'x'.repeat(300) });

    const res = await list();
    const { assets } = await jsonOf<{
      assets: { id: string; type: string; size: number; name: string }[];
    }>(res);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(byId.get(named.id)).toEqual({
      id: named.id,
      type: 'image/png',
      size: 100,
      name: 'ドラゴン.png',
    });
    expect(byId.get(unnamed.id)).toEqual({
      id: unnamed.id,
      type: 'audio/ogg',
      size: 120,
      name: '',
    });
    expect(byId.get(garbled.id)?.name).toBe('');
    expect(byId.get(long.id)?.name).toBe('x'.repeat(255));
  });

  it('cuts a long name before a character the cut would halve', async () => {
    const halved = await freshFile(PNG_HEAD, 170);
    await put(halved.id, halved.file, {
      'X-Asset-Name': encodeURIComponent(`${'x'.repeat(254)}🐉🐉`),
    });

    const { assets } = await jsonOf<{ assets: { id: string; name: string }[] }>(await list());

    expect(assets.find((asset) => asset.id === halved.id)?.name).toBe('x'.repeat(254));
  });

  it('asks for the room’s token, and turns away a room key that cannot be one', async () => {
    expect((await list({ Authorization: '' })).status).toBe(401);
    expect(
      (await list({ Authorization: `Bearer ${assetTokenFor('pl', OTHER_ROOM_KEY)}` })).status,
    ).toBe(401);
    expect((await list({}, 'nope')).status).toBe(400);
  });

  it('stops one address once it has listed its share', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await list({ 'CF-Connecting-IP': ip })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('OPTIONS /v1/rooms/:roomKey/assets/:id', () => {
  const preflight = (origin: string, method: string, requestHeaders?: string) => {
    const headers: Record<string, string> = {
      Origin: origin,
      'Access-Control-Request-Method': method,
    };
    if (requestHeaders) headers['Access-Control-Request-Headers'] = requestHeaders;
    return call('c'.repeat(64), { method: 'OPTIONS', headers });
  };

  it.each(['PUT', 'GET', 'HEAD'])('lets a listed page send a %s with its token', async (method) => {
    const res = await preflight(ORIGIN, method, 'authorization');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain(method);
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type,Authorization,X-Asset-Name',
    );
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('refuses a page that is not listed', async () => {
    const res = await preflight('https://elsewhere.example', 'GET');
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('the store that held assets for every room', () => {
  it('is gone', async () => {
    const { id } = await freshFile();

    const res = await harness.fetch(
      new Request(`https://backend.example/v1/assets/${id}`, { headers: { Origin: ORIGIN } }),
    );

    expect(res.status).toBe(404);
  });
});

describe('configuration', () => {
  it('answers 500 with config-invalid while a setting is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await harness.fetchWith(new Request(`${BASE}/${'a'.repeat(64)}`), {
      ACCESS_CONTROL_ALLOW_ORIGIN: undefined,
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'config-invalid' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ACCESS_CONTROL_ALLOW_ORIGIN'));
  });
});
