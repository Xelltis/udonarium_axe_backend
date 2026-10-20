import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import http from '../../contracts/fixtures/http.json' with { type: 'json' };
import type { AssetStoredResponse, ErrorCode, UploadTicketResponse } from '../../contracts/protocol.js';
import { MAX_ANY_BYTES, MAX_BYTES } from '../../src/core/assets/limits.js';
import { UPLOAD_TICKET_SECONDS, signToken } from '../../src/core/auth/tokens.js';
import type { DirectUploads, ServerBackend, ServerEnv } from '../../src/core/http/backend.js';
import { serverRoutes } from '../../src/core/http/routes/index.js';
import { noModeration } from '../../src/core/moderation/activity.js';
import { harness } from '../harness.js';
import type { Bytes } from './helpers.js';
import {
  ORIGIN,
  PNG_HEAD,
  ROOM_KEY,
  SESSION_SECRET,
  UPLOADER,
  assetTokenFor,
  fileOf,
  jsonOf,
  call,
  sha256Hex,
  shapeOf,
  textOf,
} from './helpers.js';
import { prepareAssetRooms } from './room-helpers.js';

// Checks, with a fake room server, the flow of uploading straight to the store (which the Vercel version
// has). The same route on every room server hands out where to upload on a room server that has the
// flow, and answers not-found on one that does not.

afterEach(() => {
  vi.restoreAllMocks();
});

const MAX_PUT_BYTES = 100;

/** A body sent as it is, not as JSON. */
class Raw {
  constructor(readonly text: string) {}
}

/** A fake room server that holds in memory what is uploaded for now and what is kept. */
const setUp = (options: { direct?: boolean; roomStorageLimitBytes?: number } = {}) => {
  const uploaded = new Map<string, Bytes>();
  /** The uploads said done, whose tickets are taken. */
  const claimed = new Set<string>();
  const kept = new Map<string, { type: string; name: string }>();
  const sizes = new Map<string, number>();
  const direct: DirectUploads = {
    maxPutBytes: MAX_PUT_BYTES,
    target: async (path, size) => ({
      url: `https://blob.example/${path}?size=${size}`,
      method: 'PUT',
      headers: { 'x-blob': 'private' },
      expiresAt: 1_000,
    }),
    open: async (path) => {
      const bytes = uploaded.get(path);
      return bytes ? new Blob([bytes]).stream() : null;
    },
    discard: async (path) => void uploaded.delete(path),
    claim: async (path) => !claimed.has(path) && Boolean(claimed.add(path)),
    release: async (path) => void claimed.delete(path),
  };
  const backend = {
    addressOf: () => '192.0.2.1',
    limit: vi.fn(async () => true),
    moderation: noModeration,
    rooms: {
      canUpload: vi.fn<ServerBackend['rooms']['canUpload']>(async () => 'ok'),
    },
    assets: {
      blocked: async (id: string) => id === 'b'.repeat(64),
      exists: async (_roomKey: string, id: string) => kept.has(id),
      store: async (
        _roomKey: string,
        id: string,
        body: ReadableStream<Uint8Array>,
        length: number,
        type: string,
        name: string
      ) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer()) as Bytes;
        if (bytes.byteLength !== length || (await sha256Hex(bytes)) !== id) return 'hash-mismatch';
        kept.set(id, { type, name });
        sizes.set(id, length);
        return 'stored';
      },
      list: async () => [...kept.keys()].map((id) => ({ id, size: sizes.get(id) as number })),
      discard: vi.fn(async (_roomKey: string, id: string) => void kept.delete(id)),
      afterStore: vi.fn(),
      ...(options.direct === false ? {} : { direct }),
    },
  };
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
      roomStorageLimitBytes: options.roomStorageLimitBytes ?? null,
      contactUrl: null,
      roomRetentionSeconds: 3600,
    });
    c.set('backend', backend as unknown as ServerBackend);
    await next();
  });
  app.route('/v1', serverRoutes());

  /** Sends the body as JSON. A Raw is sent as it is (to try bodies that are not JSON). */
  const post = (path: string, body: unknown, token: string | null = assetTokenFor('pl')) =>
    app.fetch(
      new Request(`https://backend.example/v1/rooms/${path}`, {
        method: 'POST',
        body: body instanceof Raw ? body.text : JSON.stringify(body),
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
    );
  /** Asks where to upload. */
  const ask = (id: string, body: unknown, token?: string | null) =>
    post(`${ROOM_KEY}/assets/${id}/uploads`, body, token);
  /** Says the upload is done. */
  const finish = (id: string, ticket: string, token?: string | null) =>
    post(`${ROOM_KEY}/assets/${id}/uploads/complete`, { ticket }, token);
  /** Uploads to the place it was given, in place of the browser. */
  const upload = (ticket: UploadTicketResponse, bytes: Bytes) => {
    uploaded.set(new URL(ticket.upload.url).pathname.slice(1), bytes);
  };
  return { app, backend, uploaded, kept, ask, finish, upload, post };
};

const errorOf = async (res: Response) => (await jsonOf<{ error: ErrorCode }>(res)).error;

/** The shape of where to upload. The headers depend on the store, so their names are not compared. */
const ticketShapeOf = (ticket: UploadTicketResponse) =>
  shapeOf({ ...ticket, upload: { ...ticket.upload, headers: {} } });

/** Contents, and their id. */
const fileFor = async (head = PNG_HEAD, size = MAX_PUT_BYTES * 2) => {
  const bytes = fileOf(head, size);
  return { bytes, id: await sha256Hex(bytes) };
};

describe('putting up an asset straight to the store', () => {
  it('hands out where to put it, and keeps it once it is up, counting only the asking', async () => {
    const { backend, uploaded, kept, ask, finish, upload } = setUp();
    const { bytes, id } = await fileFor();

    const request = { ...http.uploadTicketRequest, size: bytes.byteLength, name: 'big.png' };
    const asked = await ask(id, request);
    const ticket = await jsonOf<UploadTicketResponse>(asked);
    upload(ticket, bytes);
    const done = await finish(id, ticket.ticket);

    expect(asked.status).toBe(201);
    expect(ticketShapeOf(ticket)).toEqual(ticketShapeOf(http.uploadTicket as UploadTicketResponse));
    expect(shapeOf({ ticket: ticket.ticket })).toEqual(shapeOf(http.uploadComplete));
    expect(ticket.upload).toEqual({
      url: expect.stringMatching(new RegExp(`^https://blob\\.example/uploads/${ROOM_KEY}/${id}/`)),
      method: 'PUT',
      headers: { 'x-blob': 'private' },
      expiresAt: 1_000,
    });
    expect(done.status).toBe(201);
    expect(await jsonOf<AssetStoredResponse>(done)).toEqual({ id, status: 'stored' });
    expect(kept.get(id)).toEqual({ type: 'image/png', name: 'big.png' });
    expect(uploaded.size).toBe(0);
    expect(backend.assets.afterStore).toHaveBeenCalledOnce();
    expect(backend.limit).toHaveBeenCalledOnce();
  });

  it('checks again, once each is up, that the room has room for it, however many tickets went out', async () => {
    const first = await fileFor(PNG_HEAD, MAX_PUT_BYTES * 2);
    const second = await fileFor(PNG_HEAD, MAX_PUT_BYTES * 2 + 1);
    const { kept, uploaded, ask, finish, upload } = setUp({
      roomStorageLimitBytes: first.bytes.byteLength + second.bytes.byteLength - 1,
    });

    // Both tickets go out while the room is empty: neither is stored yet to count.
    const tickets: UploadTicketResponse[] = [];
    for (const { bytes, id } of [first, second]) {
      const asked = await ask(id, { size: bytes.byteLength });
      expect(asked.status).toBe(201);
      tickets.push(await jsonOf<UploadTicketResponse>(asked));
    }
    upload(tickets[0], first.bytes);
    upload(tickets[1], second.bytes);

    expect((await finish(first.id, tickets[0].ticket)).status).toBe(201);
    const refused = await finish(second.id, tickets[1].ticket);
    expect(refused.status).toBe(413);
    expect(await errorOf(refused)).toBe('room-storage-full');
    expect([...kept.keys()]).toEqual([first.id]);
    expect(uploaded.size).toBe(0);
  });

  it('keeps the room within its limit when uploads are said done at the same moment', async () => {
    const files = [await fileFor(PNG_HEAD, MAX_PUT_BYTES * 2), await fileFor(PNG_HEAD, MAX_PUT_BYTES * 2 + 1)];
    const limit = files[0].bytes.byteLength + files[1].bytes.byteLength - 1;
    const { kept, ask, finish, upload } = setUp({ roomStorageLimitBytes: limit });
    const tickets: UploadTicketResponse[] = [];
    for (const { bytes, id } of files) {
      const ticket = await jsonOf<UploadTicketResponse>(await ask(id, { size: bytes.byteLength }));
      upload(ticket, bytes);
      tickets.push(ticket);
    }

    const done = await Promise.all(files.map(({ id }, at) => finish(id, tickets[at].ticket)));

    expect(done.map((res) => res.status)).toContain(413);
    const sizes = files.filter(({ id }) => kept.has(id)).map(({ bytes }) => bytes.byteLength);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(limit);
  });

  it('answers that it is there already, before and after the upload, and lets the upload go', async () => {
    const { kept, uploaded, ask, finish, upload } = setUp();
    const { bytes, id } = await fileFor();
    const ticket = await jsonOf<UploadTicketResponse>(await ask(id, { size: bytes.byteLength }));
    upload(ticket, bytes);
    kept.set(id, { type: 'image/png', name: '' });

    const before = await ask(id, { size: bytes.byteLength });
    const after = await finish(id, ticket.ticket);

    expect(before.status).toBe(200);
    expect(await jsonOf<AssetStoredResponse>(before)).toEqual({ id, status: 'exists' });
    expect(after.status).toBe(200);
    expect(await jsonOf<AssetStoredResponse>(after)).toEqual({ id, status: 'exists' });
    expect(uploaded.size).toBe(0);
  });

  it('asks for the room key, the id, the size and the token before handing out anything', async () => {
    const { backend, ask, post } = setUp();
    const { bytes, id } = await fileFor();
    const size = bytes.byteLength;

    const answers = [
      await post(`not-a-room/assets/${id}/uploads`, { size }),
      await ask('not-an-id', { size }),
      await ask(id, { size: 0 }),
      await ask(id, 'nothing'),
      await ask(id, new Raw('{')),
      await ask(id, { size: MAX_ANY_BYTES + 1 }),
      await ask(id, { size }, null),
      await ask(id, { size }, assetTokenFor('guest')),
      await ask('b'.repeat(64), { size }),
    ];
    backend.rooms.canUpload.mockResolvedValueOnce('room-not-found');
    answers.push(await ask(id, { size }));
    backend.rooms.canUpload.mockResolvedValueOnce('not-a-player');
    answers.push(await ask(id, { size }));
    backend.limit.mockResolvedValueOnce(false);
    answers.push(await ask(id, { size }));

    expect(await Promise.all(answers.map(async (res) => [res.status, await errorOf(res)]))).toEqual([
      [400, 'invalid-id'],
      [400, 'invalid-id'],
      [400, 'invalid-request'],
      [400, 'invalid-request'],
      [400, 'invalid-request'],
      [413, 'too-large'],
      [401, 'asset-token-required'],
      [403, 'not-a-player'],
      [451, 'blocked'],
      [404, 'room-not-found'],
      [403, 'not-a-player'],
      [429, 'rate-limited'],
    ]);
  });

  it('takes only a ticket given to this person for this asset in this room', async () => {
    const { finish, post } = setUp();
    const { id } = await fileFor();
    const ticketFor = (claims: { room?: string; id?: string; uid?: string }) =>
      signToken<'upload'>(
        {
          aud: 'upload',
          room: ROOM_KEY,
          id,
          uid: UPLOADER,
          size: 200,
          name: '',
          path: `uploads/${ROOM_KEY}/${id}/x`,
          ...claims,
        },
        UPLOAD_TICKET_SECONDS,
        SESSION_SECRET
      );

    const answers = [
      await post(`not-a-room/assets/${id}/uploads/complete`, { ticket: ticketFor({}) }),
      await finish('not-an-id', ticketFor({})),
      await post(`${ROOM_KEY}/assets/${id}/uploads/complete`, {}),
      await post(`${ROOM_KEY}/assets/${id}/uploads/complete`, new Raw('{')),
      await finish(id, ticketFor({}), null),
      await finish(id, 'not.a.ticket'),
      await finish(id, ticketFor({ room: 'f'.repeat(32) })),
      await finish(id, ticketFor({ id: 'c'.repeat(64) })),
      await finish(id, ticketFor({ uid: 'someone-else' })),
      await finish(id, ticketFor({})),
    ];

    expect(await Promise.all(answers.map(async (res) => [res.status, await errorOf(res)]))).toEqual([
      [400, 'invalid-id'],
      [400, 'invalid-id'],
      [400, 'invalid-request'],
      [400, 'invalid-request'],
      [401, 'asset-token-required'],
      [400, 'invalid-request'],
      [400, 'invalid-request'],
      [400, 'invalid-request'],
      [400, 'invalid-request'],
      [404, 'not-found'],
    ]);
  });

  it('takes each ticket once, however often or at once it is said done, until something is up', async () => {
    const { kept, ask, finish, upload } = setUp();
    const { bytes, id } = await fileFor();
    const ticket = await jsonOf<UploadTicketResponse>(await ask(id, { size: bytes.byteLength }));
    const other = await fileFor(PNG_HEAD, MAX_PUT_BYTES * 3);
    const spent = await jsonOf<UploadTicketResponse>(await ask(other.id, { size: other.bytes.byteLength }));

    // Said done before the upload: it may be said again once it is up.
    expect((await finish(id, ticket.ticket)).status).toBe(404);
    upload(ticket, bytes);
    const [first, second] = await Promise.all([finish(id, ticket.ticket), finish(id, ticket.ticket)]);
    // Said again once it is in, as when the answer was lost: it is there.
    const again = await finish(id, ticket.ticket);
    // A ticket spent on what could not be kept is not taken again.
    const wrong = other.bytes.slice() as Bytes;
    wrong[wrong.length - 1] ^= 1;
    upload(spent, wrong);
    expect((await finish(other.id, spent.ticket)).status).toBe(400);
    const retried = await finish(other.id, spent.ticket);

    expect(first.status).toBe(201);
    expect([200, 400]).toContain(second.status);
    expect(await jsonOf<AssetStoredResponse>(again)).toEqual({ id, status: 'exists' });
    expect([retried.status, await errorOf(retried)]).toEqual([400, 'invalid-request']);
    expect(kept.has(id)).toBe(true);
  });

  it('keeps nothing that is not what was promised, and lets the upload go each time', async () => {
    const { backend, uploaded, kept, ask, finish, upload } = setUp();
    const tryWith = async (file: { bytes: Bytes; id: string }, size: number, bytes: Bytes = file.bytes) => {
      const ticket = await jsonOf<UploadTicketResponse>(await ask(file.id, { size }));
      upload(ticket, bytes);
      const res = await finish(file.id, ticket.ticket);
      return [res.status, await errorOf(res)];
    };
    const png = await fileFor();
    const text = { bytes: textOf('plain words, not a picture'), id: 'd'.repeat(64) };

    const answers = [
      await tryWith(text, text.bytes.byteLength),
      await tryWith(png, MAX_BYTES.image + 1),
      await tryWith(png, png.bytes.byteLength, fileOf(PNG_HEAD, MAX_PUT_BYTES * 2, 7)),
    ];
    // The room is asked three times: when asked where to upload, when told the upload is done, and
    // after storing. The room is gone after storing.
    backend.rooms.canUpload
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('room-not-found');
    answers.push(await tryWith(png, png.bytes.byteLength));

    expect(answers).toEqual([
      [415, 'unsupported-type'],
      [413, 'too-large'],
      [400, 'hash-mismatch'],
      [404, 'room-not-found'],
    ]);
    expect(backend.assets.discard).toHaveBeenCalledWith(ROOM_KEY, png.id);
    expect(kept.size).toBe(0);
    expect(uploaded.size).toBe(0);
  });

  it('turns away a PUT larger than one request may carry', async () => {
    const { app } = setUp();
    const { bytes, id } = await fileFor();

    const res = await app.fetch(
      new Request(`https://backend.example/v1/rooms/${ROOM_KEY}/assets/${id}`, {
        method: 'PUT',
        body: bytes,
        headers: {
          Origin: ORIGIN,
          'Content-Length': String(bytes.byteLength),
          Authorization: `Bearer ${assetTokenFor('pl')}`,
        },
      })
    );

    expect(res.status).toBe(413);
    expect(await errorOf(res)).toBe('too-large');
  });

  it('is not there on a room server that takes every asset in one PUT', async () => {
    const { ask, finish } = setUp({ direct: false });
    const { id } = await fileFor();

    const answers = [await ask(id, { size: 200 }), await finish(id, 'a.b.c')];

    expect(await Promise.all(answers.map(async (res) => [res.status, await errorOf(res)]))).toEqual([
      [404, 'not-found'],
      [404, 'not-found'],
    ]);
  });
});

describe('this room server', () => {
  it('hands out where to put an asset straight to the store only when it says it does', async () => {
    await prepareAssetRooms();
    const { bytes, id } = await fileFor();

    const res = await call(`${id}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ size: bytes.byteLength }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${assetTokenFor('pl')}`,
      },
    });

    if (harness.assetUpload?.directUpload) {
      expect(res.status).toBe(201);
      expect(ticketShapeOf(await jsonOf<UploadTicketResponse>(res))).toEqual(
        ticketShapeOf(http.uploadTicket as UploadTicketResponse)
      );
    } else {
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('not-found');
    }
  });
});
