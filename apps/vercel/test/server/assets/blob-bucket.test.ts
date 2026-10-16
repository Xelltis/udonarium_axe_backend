import { afterEach, describe, expect, it, vi } from 'vitest';

const blob = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    put: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    del: vi.fn(),
    list: vi.fn(),
  };
});

vi.mock('@vercel/blob', () => blob);

import { blobBucket, bucketFor } from '../../../src/server/assets/blob-bucket.js';
import { configOf } from '../server-helpers.js';

afterEach(() => {
  vi.resetAllMocks();
});

describe('the Vercel Blob bucket', () => {
  it('keeps bytes privately under their own name, and hands them back as they stream', async () => {
    const bucket = blobBucket();
    const stream = new Blob([new Uint8Array([1])]).stream();
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream }).mockResolvedValueOnce(null);

    await bucket.put('rooms/r/a', new Uint8Array([0, 1, 2, 3]).subarray(1, 3), 'image/png');

    const [path, body, options] = blob.put.mock.calls[0] as [string, Buffer, unknown];
    expect(path).toBe('rooms/r/a');
    expect([...body]).toEqual([1, 2]);
    expect(options).toEqual({
      access: 'private',
      contentType: 'image/png',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    expect(await bucket.get('rooms/r/a')).toBe(stream);
    expect(await bucket.get('rooms/r/none')).toBeNull();
    expect(blob.get).toHaveBeenCalledWith('rooms/r/a', { access: 'private' });
  });

  it('tells what is there, and passes on what else goes wrong', async () => {
    const bucket = blobBucket();
    blob.head
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new blob.BlobNotFoundError())
      .mockRejectedValueOnce(new Error('down'));

    expect(await bucket.exists('a')).toBe(true);
    expect(await bucket.exists('b')).toBe(false);
    await expect(bucket.exists('c')).rejects.toThrow('down');
  });

  it('takes away only when there is something to take', async () => {
    const bucket = blobBucket();

    await bucket.delete([]);
    await bucket.delete(['a', 'b']);

    expect(blob.del).toHaveBeenCalledOnce();
    expect(blob.del).toHaveBeenCalledWith(['a', 'b']);
  });

  it('lists a page at a time', async () => {
    const bucket = blobBucket();
    const uploadedAt = new Date(1_000);
    blob.list
      .mockResolvedValueOnce({
        blobs: [{ pathname: 'rooms/r/a', uploadedAt }],
        cursor: 'next',
        hasMore: true,
      })
      .mockResolvedValueOnce({ blobs: [], hasMore: false });

    expect(await bucket.list('rooms/', null)).toEqual({
      items: [{ path: 'rooms/r/a', uploadedAt: 1_000 }],
      cursor: 'next',
    });
    expect(await bucket.list('rooms/', 'next')).toEqual({ items: [], cursor: null });
    expect(blob.list.mock.calls).toEqual([
      [{ prefix: 'rooms/', cursor: undefined, limit: 1000 }],
      [{ prefix: 'rooms/', cursor: 'next', limit: 1000 }],
    ]);
  });

  it('is chosen unless a directory is set for trying things out', async () => {
    blob.head.mockResolvedValue({});

    expect(await bucketFor(configOf()).exists('a')).toBe(true);
    expect(await bucketFor(configOf({ BLOB_LOCAL_DIR: '/nowhere' })).exists('a')).toBe(false);
    expect(blob.head).toHaveBeenCalledOnce();
  });
});
