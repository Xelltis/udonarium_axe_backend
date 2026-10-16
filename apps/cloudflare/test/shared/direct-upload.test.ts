import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import http from '../../contracts/fixtures/http.json' with { type: 'json' };
import type {
  AssetStoredResponse,
  ErrorCode,
  UploadTicketResponse,
} from '../../contracts/protocol.js';
import { MAX_ANY_BYTES, MAX_BYTES } from '../../src/core/assets/limits.js';
import { UPLOAD_TICKET_SECONDS, signToken } from '../../src/core/auth/tokens.js';
import type { DirectUploads, ServerBackend, ServerEnv } from '../../src/core/http/backend.js';
import { serverRoutes } from '../../src/core/http/routes/index.js';
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

// 置き場所へ直接上げる流れ（Vercel 版が持つ）を、作り物の部屋のサーバーで確かめる。どの部屋のサーバーでも
// 同じ経路が、持つ部屋のサーバーでは上げる先を渡し、持たない部屋のサーバーでは not-found と答える

afterEach(() => {
  vi.restoreAllMocks();
});

const MAX_PUT_BYTES = 100;

/** JSON にせず、そのまま送る本文 */
class Raw {
  constructor(readonly text: string) {}
}

/** 仮置きと置いたものをメモリに持つ、作り物の部屋のサーバー */
const setUp = (options: { direct?: boolean } = {}) => {
  const uploaded = new Map<string, Bytes>();
  const kept = new Map<string, { type: string; name: string }>();
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
  };
  const backend = {
    limit: vi.fn(async () => true),
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
        name: string,
      ) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer()) as Bytes;
        if (bytes.byteLength !== length || (await sha256Hex(bytes)) !== id) return 'hash-mismatch';
        kept.set(id, { type, name });
        return 'stored';
      },
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
    });
    c.set('backend', backend as unknown as ServerBackend);
    await next();
  });
  app.route('/v1', serverRoutes());

  /** 本文は JSON にして送る。Raw は、そのまま送る（JSON でない本文を試すため） */
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
      }),
    );
  /** 上げる先を尋ねる */
  const ask = (id: string, body: unknown, token?: string | null) =>
    post(`${ROOM_KEY}/assets/${id}/uploads`, body, token);
  /** 上げ終えたと知らせる */
  const finish = (id: string, ticket: string, token?: string | null) =>
    post(`${ROOM_KEY}/assets/${id}/uploads/complete`, { ticket }, token);
  /** ブラウザの代わりに、渡された先へ上げる */
  const upload = (ticket: UploadTicketResponse, bytes: Bytes) => {
    uploaded.set(new URL(ticket.upload.url).pathname.slice(1), bytes);
  };
  return { app, backend, uploaded, kept, ask, finish, upload, post };
};

const errorOf = async (res: Response) => (await jsonOf<{ error: ErrorCode }>(res)).error;

/** 上げる先の形。ヘッダーは置き場所しだいなので、名前までは比べない */
const ticketShapeOf = (ticket: UploadTicketResponse) =>
  shapeOf({ ...ticket, upload: { ...ticket.upload, headers: {} } });

/** 中身と、その ID */
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

    expect(await Promise.all(answers.map(async (res) => [res.status, await errorOf(res)]))).toEqual(
      [
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
      ],
    );
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
        SESSION_SECRET,
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

    expect(await Promise.all(answers.map(async (res) => [res.status, await errorOf(res)]))).toEqual(
      [
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
      ],
    );
  });

  it('keeps nothing that is not what was promised, and lets the upload go each time', async () => {
    const { backend, uploaded, kept, ask, finish, upload } = setUp();
    const tryWith = async (
      file: { bytes: Bytes; id: string },
      size: number,
      bytes: Bytes = file.bytes,
    ) => {
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
    // 尋ねたとき、知らせを受けたとき、置いたあと、の3度尋ねる。置いたあとで部屋が無くなる
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
      }),
    );

    expect(res.status).toBe(413);
    expect(await errorOf(res)).toBe('too-large');
  });

  it('is not there on a room server that takes every asset in one PUT', async () => {
    const { ask, finish } = setUp({ direct: false });
    const { id } = await fileFor();

    const answers = [await ask(id, { size: 200 }), await finish(id, 'a.b.c')];

    expect(await Promise.all(answers.map(async (res) => [res.status, await errorOf(res)]))).toEqual(
      [
        [404, 'not-found'],
        [404, 'not-found'],
      ],
    );
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
        ticketShapeOf(http.uploadTicket as UploadTicketResponse),
      );
    } else {
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe('not-found');
    }
  });
});
