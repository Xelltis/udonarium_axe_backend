import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assetHeaders } from '../../src/core/assets/headers.js';
import { readHead, rejoin } from '../../src/core/assets/upload.js';
import type { ServerBackend, ServerEnv } from '../../src/core/http/backend.js';
import { onError } from '../../src/core/http/errors.js';
import { serverRoutes } from '../../src/core/http/routes/index.js';
import { noModeration } from '../../src/core/moderation/activity.js';
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

describe('putting up an asset', () => {
  it('takes it away again when the room went while it was being kept', async () => {
    const file = fileOf(PNG_HEAD, 64);
    const id = await sha256Hex(file);
    const canUpload = vi
      .fn<ServerBackend['rooms']['canUpload']>()
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('room-not-found');
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
      },
    } as unknown as ServerBackend;
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
        roomStorageLimitBytes: null,
        roomRetentionSeconds: 3600,
      });
      c.set('backend', backend);
      await next();
    });
    app.route('/v1', serverRoutes());

    const res = await app.fetch(
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

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'room-not-found' });
    expect(discard).toHaveBeenCalledWith(ROOM_KEY, id);
    expect(afterStore).not.toHaveBeenCalled();
  });
});
