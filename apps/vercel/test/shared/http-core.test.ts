import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assetHeaders } from '../../src/core/assets/headers.js';
import { readHead, rejoin } from '../../src/core/assets/upload.js';
import type { ServerBackend, ServerEnv } from '../../src/core/http/backend.js';
import { onError } from '../../src/core/http/errors.js';
import { serverRoutes } from '../../src/core/http/routes/index.js';
import { noModeration } from '../../src/core/moderation/activity.js';
import { BanList, NO_PAUSE } from '../../src/core/moderation/bans.js';
import { ORIGIN, PNG_HEAD, ROOM_KEY, SESSION_SECRET, assetTokenFor, fileOf, sha256Hex } from './helpers.js';

// The routes and the small pieces they use. Checks, with a fake room server, what is hard to bring
// about from the room server.

afterEach(() => {
  vi.restoreAllMocks();
});

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const bytesOf = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

describe('assetHeaders', () => {
  it('serves bytes kept without a type as plain octets', () => {
    const headers = assetHeaders({ type: undefined, size: 1, etag: '"x"', name: undefined });
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.has('X-Asset-Name')).toBe(false);
  });
});

describe('rejoin', () => {
  it('puts the part read ahead back in front of the rest, however many pieces the rest comes in', async () => {
    const pieces = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])];
    const reader = streamOf(pieces).getReader();

    const head = await readHead(reader, 2);

    expect(head).toEqual([pieces[0]]);
    expect(await bytesOf(rejoin(head, reader))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe('onError', () => {
  it('answers 500 internal-error to what nobody expected, and says so in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono();
    app.onError(onError);
    app.get('/', () => {
      throw new Error('broken');
    });

    const res = await app.fetch(new Request('https://backend.example/'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal-error' });
    expect(error).toHaveBeenCalledWith('Unhandled error:', expect.any(Error));
  });
});

/** The routes, in front of a fake room server. */
const appOf = (backend: ServerBackend, roomStorageLimitBytes: number | null = null) => {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('config', {
      allowedOrigins: [ORIGIN],
      login: {
        discordClientId: 'id',
        discordClientSecret: 'secret',
        sessionSecret: SESSION_SECRET,
      },
      admin: null,
      adminWebhook: null,
      storageAlertBytes: null,
      roomStorageLimitBytes,
      contactUrl: null,
      roomRetentionSeconds: 3600,
    });
    c.set('backend', backend);
    await next();
  });
  app.route('/v1', serverRoutes());
  return app;
};

describe('putting up an asset', () => {
  /** A room server that keeps whatever comes, with the room's answers and listings given. */
  const putWith = async (
    canUpload: ServerBackend['rooms']['canUpload'],
    usage: ServerBackend['assets']['usage'],
    limit: number | null = null
  ) => {
    const file = fileOf(PNG_HEAD, 64);
    const id = await sha256Hex(file);
    const discard = vi.fn(async () => undefined);
    const afterStore = vi.fn();
    const backend = {
      addressOf: () => '192.0.2.1',
      limit: async () => true,
      moderation: noModeration,
      rooms: { canUpload },
      assets: {
        blocked: async () => false,
        exists: async () => false,
        store: async () => 'stored' as const,
        discard,
        afterStore,
        usage,
      },
    } as unknown as ServerBackend;
    const res = await appOf(backend, limit).fetch(
      new Request(`https://backend.example/v1/rooms/${ROOM_KEY}/assets/${id}`, {
        method: 'PUT',
        body: file,
        headers: {
          Origin: ORIGIN,
          'Content-Length': String(file.byteLength),
          Authorization: `Bearer ${assetTokenFor('pl')}`,
        },
      })
    );
    return { res, id, discard, afterStore };
  };

  it('takes it away again when the room went while it was being kept', async () => {
    const canUpload = vi
      .fn<ServerBackend['rooms']['canUpload']>()
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('room-not-found');
    const { res, id, discard, afterStore } = await putWith(canUpload, async () => 0);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'room-not-found' });
    expect(discard).toHaveBeenCalledWith(ROOM_KEY, id);
    expect(afterStore).not.toHaveBeenCalled();
  });

  it('takes it away again when others stored at the same moment took the room past its limit', async () => {
    // Empty as it is counted before, and full with what came at the same moment once it is in.
    const usage = vi.fn<ServerBackend['assets']['usage']>().mockResolvedValueOnce(0).mockResolvedValueOnce(128);
    const { res, id, discard, afterStore } = await putWith(async () => 'ok', usage, 100);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'room-storage-full' });
    expect(discard).toHaveBeenCalledWith(ROOM_KEY, id);
    expect(afterStore).not.toHaveBeenCalled();
  });
});

describe('taking an asset out', () => {
  const backendWith = (limit: () => Promise<boolean>) => {
    const discard = vi.fn(async () => undefined);
    const backend = {
      addressOf: () => '192.0.2.1',
      limit: vi.fn(limit),
      // The operator has stopped storing for now.
      moderation: { ...noModeration, fresh: async () => new BanList([], { ...NO_PAUSE, uploads: true }) },
      rooms: { canDiscard: async () => 'ok' },
      assets: { discard },
    } as unknown as ServerBackend;
    return { backend, discard };
  };
  const deleteIn = (backend: ServerBackend) =>
    appOf(backend).fetch(
      new Request(`https://backend.example/v1/rooms/${ROOM_KEY}/assets/${'a'.repeat(64)}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Authorization: `Bearer ${assetTokenFor('gm')}` },
      })
    );

  it('is counted with storing, and is not stopped while storing is', async () => {
    const { backend, discard } = backendWith(async () => true);

    expect((await deleteIn(backend)).status).toBe(204);
    expect(backend.limit).toHaveBeenCalledWith(expect.any(Request), 'upload');
    expect(discard).toHaveBeenCalledWith(ROOM_KEY, 'a'.repeat(64));
  });

  it('takes nothing out past the limit', async () => {
    const { backend, discard } = backendWith(async () => false);

    const res = await deleteIn(backend);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate-limited' });
    expect(discard).not.toHaveBeenCalled();
  });
});
