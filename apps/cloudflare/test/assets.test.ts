import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_BYTES } from '../src/assets/routes';
import app from '../src/index';
import {
  BASE,
  DAY_MS,
  OGG_HEAD,
  ORIGIN,
  PNG_HEAD,
  call,
  fileOf,
  freshFile,
  freshIp,
  put,
  sha256Hex,
} from './helpers';

const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** Date.now() だけを進める。R2 の uploaded は実際の時刻のまま */
const travel = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PUT /v1/assets/:id', () => {
  it('stores bytes under their own hash, with the type read from the bytes', async () => {
    const { file, id } = await freshFile(PNG_HEAD, 1024);

    const res = await put(id, file, { 'Content-Type': 'text/plain' });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id, status: 'stored' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toContain('Origin');
    const stored = await env.ASSETS.get(id);
    expect(stored?.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(file);
  });

  it('answers 200 without writing again or counting, when the asset is already there', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const before = await env.ASSETS.head(id);
    const ip = freshIp();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await put(id, file, { 'CF-Connecting-IP': ip });
      statuses.push(res.status);
      expect(await res.json()).toEqual({ id, status: 'exists' });
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await env.ASSETS.head(id))?.uploaded).toEqual(before?.uploaded);
  });

  it('stores an asset again once its retention has run out', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const before = await env.ASSETS.head(id);
    travel(31 * DAY_MS);

    const res = await put(id, file);

    expect(res.status).toBe(201);
    expect((await env.ASSETS.head(id))?.uploaded).not.toEqual(before?.uploaded);
  });

  it('turns away bytes whose hash is not the name, and stores nothing', async () => {
    const { file } = await freshFile();
    const { id: wrongId } = await freshFile();

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
    const res = await call(id, {
      method: 'PUT',
      body: streamed,
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ error: 'length-required' });
  });

  it.each([
    ['no Origin', undefined],
    ['an Origin not on the list', 'https://elsewhere.example'],
  ])('refuses an upload with %s', async (_name, origin) => {
    const { file, id } = await freshFile(PNG_HEAD, 64);
    const headers: Record<string, string> = {
      'Content-Length': String(file.byteLength),
    };
    if (origin) headers['Origin'] = origin;

    const res = await call(id, { method: 'PUT', body: file, headers });

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
  });
});

describe('GET /v1/assets/:id', () => {
  it('hands the stored bytes to anyone, readable from any page', async () => {
    const { file, id } = await freshFile(OGG_HEAD, 512);
    await put(id, file);

    const res = await call(id, { headers: { Origin: 'https://elsewhere.example' } });

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    expect(res.headers.get('Content-Type')).toBe('audio/ogg');
    expect(res.headers.get('Content-Length')).toBe('512');
    expect(res.headers.get('ETag')).toBe((await env.ASSETS.head(id))?.httpEtag);
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${WEEK_SECONDS}, immutable`);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Vary')).toBeNull();
  });

  it('lets caches keep a copy no longer than the asset stays in the bucket', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    travel(25 * DAY_MS);

    const res = await call(id);

    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1]);
    expect(maxAge).toBeLessThanOrEqual(RETENTION_SECONDS - 25 * 24 * 60 * 60);
    expect(maxAge).toBeGreaterThan(RETENTION_SECONDS - 25 * 24 * 60 * 60 - 60);
  });

  it('answers 404 for an asset past its retention, even before the bucket drops it', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    travel(30 * DAY_MS + 1000);

    expect((await call(id)).status).toBe(404);
    expect((await call(id, { method: 'HEAD' })).status).toBe(404);
  });

  it('serves bytes stored without a type as plain octets', async () => {
    const { file, id } = await freshFile();
    await env.ASSETS.put(id, file);

    const res = await call(id);

    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('keeps a copy in the data centre and serves it from there', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const ctx = createExecutionContext();
    const first = await app.fetch(new Request(`${BASE}/${id}`), env, ctx);
    await first.arrayBuffer();
    await waitOnExecutionContext(ctx);
    // R2 から消しても、データセンターのキャッシュから返る。R2 の読み出しにも数えない
    await env.ASSETS.delete(id);
    const ip = freshIp();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await call(id, { headers: { 'CF-Connecting-IP': ip } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    const revalidated = await call(id, {
      headers: { 'If-None-Match': first.headers.get('ETag') ?? '' },
    });

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it.each([
    ['its ETag', (etag: string) => etag],
    ['its weak ETag', (etag: string) => `W/${etag}`],
    ['a list holding its ETag', (etag: string) => `"other", ${etag}`],
    ['*', () => '*'],
  ])('answers 304 to a request holding %s', async (_name, ifNoneMatch) => {
    const { file, id } = await freshFile();
    await put(id, file);
    const etag = (await env.ASSETS.head(id))?.httpEtag ?? '';

    const res = await call(id, { headers: { 'If-None-Match': ifNoneMatch(etag) } });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('ETag')).toBe(etag);
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${WEEK_SECONDS}, immutable`);
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

  it('answers 404 for an asset that is not there and 400 for a bad name', async () => {
    const { id } = await freshFile();
    const missing = await call(id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not-found' });
    expect((await call('not-a-hash')).status).toBe(400);
  });
});

describe('HEAD /v1/assets/:id', () => {
  it('tells whether an asset is there without sending it', async () => {
    const { file, id } = await freshFile(PNG_HEAD, 300);
    const missing = await call(id, { method: 'HEAD' });
    await put(id, file);

    const present = await call(id, { method: 'HEAD' });

    expect(missing.status).toBe(404);
    expect(present.status).toBe(200);
    expect(present.headers.get('Content-Length')).toBe('300');
    expect(present.headers.get('Content-Type')).toBe('image/png');
    expect(present.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await present.text()).toBe('');
  });

  it('opens no stream from R2', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const get = vi.spyOn(env.ASSETS, 'get');
    const head = vi.spyOn(env.ASSETS, 'head');

    await call(id, { method: 'HEAD' });

    expect(get).not.toHaveBeenCalled();
    expect(head).toHaveBeenCalledWith(id);
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

describe('OPTIONS /v1/assets/:id', () => {
  const preflight = (origin: string, method: string, requestHeaders?: string) => {
    const headers: Record<string, string> = {
      Origin: origin,
      'Access-Control-Request-Method': method,
    };
    if (requestHeaders) headers['Access-Control-Request-Headers'] = requestHeaders;
    return call('c'.repeat(64), { method: 'OPTIONS', headers });
  };

  it('lets a listed page send an upload', async () => {
    const res = await preflight(ORIGIN, 'PUT', 'content-type');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('refuses an upload from a page that is not listed', async () => {
    const res = await preflight('https://elsewhere.example', 'PUT');
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('lets any page read with the headers it needs', async () => {
    const res = await preflight('https://elsewhere.example', 'GET', 'if-none-match, range');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('if-none-match,range');
  });

  it('answers a bare OPTIONS as a read', async () => {
    const res = await call('c'.repeat(64), { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('configuration', () => {
  it('answers 500 with config-invalid while a setting is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...env, ACCESS_CONTROL_ALLOW_ORIGIN: undefined };

    const res = await app.fetch(
      new Request(`${BASE}/${'a'.repeat(64)}`),
      broken,
      createExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'config-invalid' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ACCESS_CONTROL_ALLOW_ORIGIN'));
  });
});

describe('GET /', () => {
  it('says hello', async () => {
    const res = await app.fetch(
      new Request('https://backend.example/'),
      env,
      createExecutionContext(),
    );
    expect(await res.json()).toEqual({ message: 'Hello udonarium-axe-backend!' });
  });
});
