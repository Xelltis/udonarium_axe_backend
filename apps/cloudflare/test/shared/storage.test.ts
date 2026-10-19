import { describe, expect, it, vi } from 'vitest';

import type { StoredRoomAsset } from '../../src/core/http/backend.js';
import { noModeration } from '../../src/core/moderation/activity.js';
import { MAX_STORAGE_PAGES, checkStorage, countStorage } from '../../src/core/moderation/storage.js';

// The daily count of the store of the rooms' pictures and sounds, and the alert when it is past the
// amount the operator set.

const assetOf = (size: number): StoredRoomAsset => ({
  roomKey: '0'.repeat(32),
  id: '1'.repeat(64),
  type: 'image/png',
  size,
  name: '',
  uploadedAt: 0,
});

/** A store of pages, each page the sizes given. */
const pagesOf = (...pages: number[][]) =>
  vi.fn(async (cursor: string | null) => {
    const at = cursor === null ? 0 : Number(cursor);
    return { assets: pages[at].map(assetOf), cursor: at + 1 < pages.length ? String(at + 1) : null };
  });

describe('counting the store', () => {
  it('adds up every page', async () => {
    const inventory = pagesOf([1, 2], [], [30]);

    const usage = await countStorage(inventory);

    expect(usage).toEqual({ bytes: 33, assets: 3, at: expect.any(Number), complete: true });
    expect(inventory).toHaveBeenCalledTimes(3);
  });

  it('stops at so many pages, saying the count is short', async () => {
    const inventory = vi.fn(async () => ({ assets: [assetOf(1)], cursor: 'more' }));

    const usage = await countStorage(inventory);

    expect(usage).toMatchObject({ bytes: MAX_STORAGE_PAGES, assets: MAX_STORAGE_PAGES, complete: false });
  });
});

describe('the daily check', () => {
  const backendOf = (sizes: number[]) => {
    const moderation = {
      ...noModeration,
      putStorageUsage: vi.fn(async () => undefined),
      alertStorage: vi.fn(async () => undefined),
    };
    return { moderation, assets: { inventory: pagesOf(sizes) } as never };
  };

  it('counts nothing when no amount is set', async () => {
    const backend = backendOf([5]);

    expect(await checkStorage({ storageAlertBytes: null }, backend)).toBeNull();
    expect(backend.moderation.putStorageUsage).not.toHaveBeenCalled();
  });

  it('keeps the count, and tells the operator only past the amount', async () => {
    const under = backendOf([5, 5]);
    const over = backendOf([5, 6]);

    await checkStorage({ storageAlertBytes: 10 }, under);
    const counted = await checkStorage({ storageAlertBytes: 10 }, over);

    expect(under.moderation.putStorageUsage).toHaveBeenCalledOnce();
    expect(under.moderation.alertStorage).not.toHaveBeenCalled();
    expect(over.moderation.alertStorage).toHaveBeenCalledWith(counted, 10);
  });
});
