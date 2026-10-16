import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { roomAssetKey } from '../../../src/core/assets/keys.js';
import { MAX_PUT_BYTES, assetIndexOf, vercelAssets } from '../../../src/server/assets/backend.js';
import { memoryBucket } from '../../../src/server/assets/bucket.js';
import type { AssetBucket } from '../../../src/server/assets/bucket.js';
import { localBucket } from '../../../src/server/assets/local-bucket.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

const ROOM = 'room';

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const hexOf = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

/** 置いたアセットと、それを読む部屋のサーバー */
const stored = async (
  options: { bucket?: AssetBucket; allowed?: boolean; afterStore?: () => void } = {},
) => {
  const bucket = options.bucket ?? memoryBucket();
  const key = freshKey();
  const assets = vercelAssets(
    connection.redis,
    key,
    bucket,
    async () => options.allowed ?? true,
    options.afterStore ?? (() => undefined),
  );
  const bytes = new Uint8Array(Array.from({ length: 10 }, (_, i) => i));
  const id = await hexOf(bytes);
  expect(
    await assets.store(
      ROOM,
      id,
      streamOf([bytes.subarray(0, 4), bytes.subarray(4)]),
      10,
      'image/png',
      'a.png',
    ),
  ).toBe('stored');
  return { assets, bucket, key, bytes, id };
};

const get = (headers: Record<string, string> = {}) =>
  new Request('https://backend.example/asset', { headers });

describe('room assets on Vercel', () => {
  it('turns away bytes whose hash or length is not what was named', async () => {
    const { assets, bytes, id } = await stored();

    expect(await assets.store(ROOM, id, streamOf([bytes.subarray(1)]), 10, 'image/png', '')).toBe(
      'hash-mismatch',
    );
    expect(await assets.store(ROOM, id, streamOf([bytes]), 9, 'image/png', '')).toBe(
      'hash-mismatch',
    );
    expect(await assets.store(ROOM, 'f'.repeat(64), streamOf([bytes]), 10, 'image/png', '')).toBe(
      'hash-mismatch',
    );
  });

  it('knows what is kept, what is blocked, and lists the room', async () => {
    const { assets, bucket, id } = await stored();
    await bucket.put(`blocked/${id}`, new Uint8Array(), '');

    expect(await assets.exists(ROOM, id)).toBe(true);
    expect(await assets.exists(ROOM, 'f'.repeat(64))).toBe(false);
    expect(await assets.blocked(id)).toBe(true);
    expect(await assets.list(ROOM)).toEqual([{ id, type: 'image/png', size: 10, name: 'a.png' }]);
  });

  it('answers HEAD from what it knows, and counts it', async () => {
    const { assets, id } = await stored();
    const { assets: tight } = await stored({ allowed: false });

    const present = await assets.head(get(), ROOM, id);
    const missing = await assets.head(get(), ROOM, 'f'.repeat(64));

    expect(present.status).toBe(200);
    expect(present.headers.get('ETag')).toBe(`"${id}"`);
    expect(missing.status).toBe(404);
    expect((await tight.head(get(), ROOM, id)).status).toBe(429);
    expect((await tight.read(get(), ROOM, id)).status).toBe(429);
  });

  it('answers conditions on its ETag and its time', async () => {
    const { assets, id } = await stored();
    const etag = `"${id}"`;
    const later = new Date(Date.now() + 60_000).toUTCString();
    const earlier = new Date(Date.now() - 60_000).toUTCString();

    const status = async (headers: Record<string, string>) =>
      (await assets.read(get(headers), ROOM, id)).status;

    expect(await status({ 'If-Match': etag })).toBe(200);
    expect(await status({ 'If-Match': '"other"' })).toBe(412);
    expect(await status({ 'If-Unmodified-Since': earlier })).toBe(412);
    expect(await status({ 'If-Unmodified-Since': later })).toBe(200);
    expect(await status({ 'If-None-Match': `W/${etag}` })).toBe(304);
    expect(await status({ 'If-None-Match': '"other"', 'If-Modified-Since': later })).toBe(200);
    expect(await status({ 'If-Modified-Since': later })).toBe(304);
    expect(await status({ 'If-Modified-Since': earlier })).toBe(200);
    const unchanged = await assets.read(get({ 'If-None-Match': '*' }), ROOM, id);
    expect(unchanged.headers.has('Content-Length')).toBe(false);
  });

  it.each([
    ['bytes=2-4', 206, 'bytes 2-4/10', [2, 3, 4]],
    ['bytes=5-', 206, 'bytes 5-9/10', [5, 6, 7, 8, 9]],
    ['bytes=-3', 206, 'bytes 7-9/10', [7, 8, 9]],
    ['bytes=-30', 206, 'bytes 0-9/10', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['bytes=8-20', 206, 'bytes 8-9/10', [8, 9]],
    ['bytes=-', 200, null, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['bytes=7-2', 200, null, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['items=1-2', 200, null, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ])('answers Range %s with %i', async (range, status, contentRange, bytes) => {
    const bucket = memoryBucket();
    const original = bucket.get.bind(bucket);
    // 中身を細かく分けて流し、切り出しがまたがるところを試す
    bucket.get = async (path) => {
      const whole = new Uint8Array(await new Response(await original(path)).arrayBuffer());
      return streamOf([whole.subarray(0, 3), whole.subarray(3, 6), whole.subarray(6)]);
    };
    const { assets, id } = await stored({ bucket });

    const res = await assets.read(get({ Range: range }), ROOM, id);

    expect(res.status).toBe(status);
    expect(res.headers.get('Content-Range')).toBe(contentRange);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(bytes);
  });

  it('answers 404 for what it does not have, or has lost the bytes of', async () => {
    const { assets, bucket, id } = await stored();
    expect((await assets.read(get(), ROOM, 'f'.repeat(64))).status).toBe(404);

    await bucket.delete([roomAssetKey(ROOM, id)]);

    expect((await assets.read(get(), ROOM, id)).status).toBe(404);
  });

  it('takes one away, and a whole room with its index', async () => {
    const { assets, key, bucket, id } = await stored();
    await assets.discard(ROOM, id);
    expect(await assets.exists(ROOM, id)).toBe(false);

    const again = await stored({ bucket });
    await again.assets.deleteRoom(ROOM);
    await again.assets.deleteRoom('empty');

    expect(await bucket.exists(roomAssetKey(ROOM, again.id))).toBe(false);
    expect(await connection.redis.exists(assetIndexOf(key, ROOM))).toBe(0);
  });

  it('has big assets put up straight to the store when the store can take them, and not otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axe-direct-'));
    const { assets, bucket } = await stored();
    const local = vercelAssets(
      connection.redis,
      freshKey(),
      localBucket(dir),
      async () => true,
      () => undefined,
    );
    const direct = assets.direct as NonNullable<typeof assets.direct>;
    await bucket.put('uploads/r/a/n', new Uint8Array([7]), '');

    const target = await direct.target('uploads/r/a/n', 1);
    const opened = await direct.open('uploads/r/a/n');
    await direct.discard('uploads/r/a/n');

    expect(direct.maxPutBytes).toBe(MAX_PUT_BYTES);
    expect(target).toMatchObject({ url: 'https://memory.example/uploads/r/a/n', method: 'PUT' });
    expect([...new Uint8Array(await new Response(opened).arrayBuffer())]).toEqual([7]);
    expect(await bucket.exists('uploads/r/a/n')).toBe(false);
    expect(local.direct).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it('does what it was given to do after storing', async () => {
    const afterStore = vi.fn();
    const { assets } = await stored({ afterStore });

    assets.afterStore();

    expect(afterStore).toHaveBeenCalledOnce();
  });
});

describe('the buckets', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['in memory', async () => memoryBucket()],
    [
      'in a directory',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'axe-bucket-'));
        dirs.push(dir);
        return localBucket(dir);
      },
    ],
  ])('keep, hand back and take away bytes %s', async (_name, make) => {
    const bucket = await make();
    await bucket.put('rooms/r/a', new Uint8Array([1, 2, 3]), 'image/png');

    expect(await bucket.exists('rooms/r/a')).toBe(true);
    const listed = await bucket.list('rooms/', null);
    expect(listed.items.map((item) => item.path)).toEqual(['rooms/r/a']);
    expect(listed.items[0]?.uploadedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(listed.cursor).toBeNull();
    expect(await bucket.list('none/', null)).toEqual({ items: [], cursor: null });
    expect([
      ...new Uint8Array(await new Response(await bucket.get('rooms/r/a')).arrayBuffer()),
    ]).toEqual([1, 2, 3]);
    await bucket.delete(['rooms/r/a', 'rooms/r/none']);
    expect(await bucket.exists('rooms/r/a')).toBe(false);
    expect(await bucket.get('rooms/r/a')).toBeNull();
  });

  it('lists what the memory keeps', async () => {
    const bucket = memoryBucket();
    await bucket.put('x', new Uint8Array(), '');
    expect(bucket.paths()).toEqual(['x']);
  });
});
