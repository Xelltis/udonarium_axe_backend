import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { BAN_CACHE_MS } from '../src/core/moderation/bans';
import app from '../src/index';
import { MODERATION_NAME } from '../src/moderation/store';
import {
  BASE,
  ORIGIN,
  OTHER_ROOM_KEY,
  PNG_HEAD,
  ROOM_KEY,
  assetTokenFor,
  call,
  freshFile,
  freshIp,
  put,
  storedKeyOf,
} from './shared/helpers';
import { prepareAssetRooms } from './shared/room-helpers';

beforeAll(prepareAssetRooms);

// What is particular to keeping a room's assets in R2 and the Cache API.

const WEEK_SECONDS = 7 * 24 * 60 * 60;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Reads once with a guest's token, and waits until the asset is left in the data center's cache. */
const readOnce = async (id: string) => {
  const ctx = createExecutionContext();
  const first = await app.fetch(
    new Request(`${BASE}/${id}`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${assetTokenFor('guest')}`, 'CF-Connecting-IP': freshIp() },
    }),
    env,
    ctx
  );
  await first.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return first;
};

describe('PUT /v1/rooms/:roomKey/assets/:id', () => {
  it('keeps a room asset under the room in R2, not at the top of the bucket', async () => {
    const { file, id } = await freshFile();

    await put(id, file);

    expect(await env.ASSETS.head(storedKeyOf(id))).not.toBeNull();
    expect(await env.ASSETS.head(id)).toBeNull();
  });

  it.each([
    ['looks for assets whose room is gone now and then', 0, 2],
    ['leaves the sweeping to other uploads mostly', 0.99, 0],
  ])('%s', async (_name, random, lists) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => array);
    const list = vi.spyOn(env.ASSETS, 'list');
    const { file, id } = await freshFile();
    const ctx = createExecutionContext();

    const res = await app.fetch(
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
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(201);
    expect(list).toHaveBeenCalledTimes(lists);
    expect(await env.ASSETS.head(storedKeyOf(id))).not.toBeNull();
  });

  it.each([
    ['ends before', '100'],
    ['runs past', '40'],
  ])('fails without storing when the body %s its declared length', async (_name, length) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { file, id } = await freshFile(PNG_HEAD, 64);

    const res = await put(id, file, { 'Content-Length': length });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal-error' });
    expect(error).toHaveBeenCalledWith('Unhandled error:', expect.any(Error));
    expect(await env.ASSETS.head(storedKeyOf(id))).toBeNull();
  });
});

describe('GET /v1/rooms/:roomKey/assets/:id', () => {
  it.each([
    ['no token', ''],
    ['a token that ran out', `Bearer ${assetTokenFor('guest', ROOM_KEY, -1)}`],
    ['a token for another room', `Bearer ${assetTokenFor('gm', OTHER_ROOM_KEY)}`],
  ])('hands nothing to %s, even what the data centre keeps', async (_name, authorization) => {
    const { file, id } = await freshFile();
    await put(id, file);
    await readOnce(id);

    const res = await call(id, { headers: { Authorization: authorization } });
    const head = await call(id, { method: 'HEAD', headers: { Authorization: authorization } });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'asset-token-required' });
    expect(head.status).toBe(401);
  });

  it('serves bytes stored without a type as plain octets', async () => {
    const { file, id } = await freshFile();
    await env.ASSETS.put(storedKeyOf(id), file);

    const res = await call(id);

    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('keeps a copy in the data centre and serves it from there, still privately', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const first = await readOnce(id);
    // Even after it is deleted from R2, it comes from the data center's cache. It does not count as a
    // read from R2 either.
    await env.ASSETS.delete(storedKeyOf(id));
    const ip = freshIp();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await call(id, { headers: { 'CF-Connecting-IP': ip } });
      statuses.push(res.status);
      expect(res.headers.get('Cache-Control')).toBe(`private, max-age=${WEEK_SECONDS}, immutable`);
      await res.arrayBuffer();
    }
    const revalidated = await call(id, {
      headers: { 'If-None-Match': first.headers.get('ETag') ?? '' },
    });

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('stops serving the copy left in the data centre once the operator takes it down', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    await readOnce(id);
    // Taken down on another instance: this one reads the bans, with what is barred, a short while later.
    await env.MODERATION.getByName(MODERATION_NAME).setBlocked(id, true);
    await env.ASSETS.delete(storedKeyOf(id));
    vi.useFakeTimers({ now: Date.now() + BAN_CACHE_MS, toFake: ['Date'] });

    const got = await call(id);
    const headed = await call(id, { method: 'HEAD' });

    expect(got.status).toBe(451);
    expect(await got.json()).toEqual({ error: 'blocked' });
    expect(headed.status).toBe(451);
    await env.MODERATION.getByName(MODERATION_NAME).setBlocked(id, false);
  });
});

describe('HEAD /v1/rooms/:roomKey/assets/:id', () => {
  it('opens no stream from R2', async () => {
    const { file, id } = await freshFile();
    await put(id, file);
    const get = vi.spyOn(env.ASSETS, 'get');
    const head = vi.spyOn(env.ASSETS, 'head');

    await call(id, { method: 'HEAD' });

    expect(get).not.toHaveBeenCalled();
    expect(head).toHaveBeenCalledWith(storedKeyOf(id));
  });

  it('answers from the copy in the data centre as GET does', async () => {
    const { file, id } = await freshFile(PNG_HEAD, 200);
    await put(id, file);
    await readOnce(id);
    await env.ASSETS.delete(storedKeyOf(id));

    const res = await call(id, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('200');
    expect(res.headers.get('Cache-Control')).toBe(`private, max-age=${WEEK_SECONDS}, immutable`);
  });
});

describe('GET /v1/rooms/:roomKey/assets', () => {
  it('reads the bucket page by page, skipping what is not an asset, up to a bound', async () => {
    const object = (key: string) => ({
      key,
      size: 1,
      httpMetadata: {},
      customMetadata: undefined,
    });
    const prefix = `rooms/${ROOM_KEY}/`;
    const pages = vi.fn((options: { cursor?: string }) =>
      Promise.resolve({
        objects: [
          object(`${prefix}${String(Number(options.cursor ?? 0)).padStart(64, '0')}`),
          object(`${prefix}notes.txt`),
        ],
        truncated: true,
        cursor: String(Number(options.cursor ?? 0) + 1),
      })
    );
    const res = await app.fetch(
      new Request(`https://backend.example/v1/rooms/${ROOM_KEY}/assets`, {
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${assetTokenFor('pl')}`,
        },
      }),
      { ...env, ASSETS: { list: pages } } as unknown as Env,
      createExecutionContext()
    );
    const { assets } = await res.json<{ assets: { type: string }[] }>();

    expect(pages).toHaveBeenCalledTimes(10);
    expect(assets).toHaveLength(10);
    expect(assets[0].type).toBe('application/octet-stream');
  });
});

describe('GET /', () => {
  it('says hello', async () => {
    const res = await app.fetch(new Request('https://backend.example/'), env, createExecutionContext());
    expect(await res.json()).toEqual({ message: 'Hello udonarium-axe-backend!' });
  });
});
