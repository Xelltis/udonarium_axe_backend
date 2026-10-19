import { describe, expect, it } from 'vitest';

import { r2Assets } from '../src/assets/r2';

// What the operator reads from R2: every room asset page by page, an asset's contents, and the
// marks that bar assets. Pages and odd keys are hard to bring about in a real bucket.

const ROOM = 'a'.repeat(32);
const ID = 'b'.repeat(64);

/** A bucket whose listing gives the pages in turn (the cursor is the page's number). */
const bucketListing = (pages: { objects: object[]; truncated: boolean }[], got: object | null = null) =>
  ({
    ASSETS: {
      list: async (options: { cursor?: string }) => {
        const index = options.cursor ? Number(options.cursor) : 0;
        const page = pages[index];
        return { ...page, ...(page.truncated ? { cursor: String(index + 1) } : {}) };
      },
      get: async () => got,
    },
  }) as unknown as Env;

const assetsOf = (env: Env) =>
  r2Assets(
    env,
    () => undefined,
    async () => true
  );

describe('the operator’s view of R2', () => {
  it('lists room assets page by page, leaving out keys that are not one, and filling in what is missing', async () => {
    const assets = assetsOf(
      bucketListing([
        {
          objects: [
            { key: `rooms/${ROOM}/${ID}`, size: 3, uploaded: new Date(5) },
            { key: `rooms/${ROOM}/${ID}/extra`, size: 1, uploaded: new Date(5) },
            { key: `rooms/${ROOM}/not-an-id`, size: 1, uploaded: new Date(5) },
            { key: 'rooms/legacy', size: 1, uploaded: new Date(5) },
          ],
          truncated: true,
        },
        {
          objects: [
            {
              key: `rooms/${ROOM}/${'c'.repeat(64)}`,
              size: 4,
              uploaded: new Date(6),
              httpMetadata: { contentType: 'image/png' },
              customMetadata: { name: 'map.png' },
            },
          ],
          truncated: false,
        },
      ])
    );

    const first = await assets.inventory(null);
    const second = await assets.inventory(first.cursor);

    expect(first).toEqual({
      assets: [{ roomKey: ROOM, id: ID, type: 'application/octet-stream', size: 3, name: '', uploadedAt: 5 }],
      cursor: '1',
    });
    expect(second).toEqual({
      assets: [{ roomKey: ROOM, id: 'c'.repeat(64), type: 'image/png', size: 4, name: 'map.png', uploadedAt: 6 }],
      cursor: null,
    });
  });

  it('reads the marks that bar assets over every page', async () => {
    const assets = assetsOf(
      bucketListing([
        { objects: [{ key: `blocked/${ID}` }], truncated: true },
        { objects: [{ key: `blocked/${'c'.repeat(64)}` }], truncated: false },
      ])
    );

    expect(await assets.blockedIds()).toEqual([ID, 'c'.repeat(64)]);
  });

  it('gives an asset’s contents as plain bytes when its type was not kept', async () => {
    const body = new ReadableStream();
    const content = await assetsOf(bucketListing([], { body })).content(ROOM, ID);

    expect(content).toEqual({ body, type: 'application/octet-stream' });
  });
});
