import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import messages from '../contracts/fixtures/messages.json';
import {
  AUTHORITY_PEER_ID,
  CATALOG_BATCH,
  CLOSE_CODE,
  MAX_MEMBERS,
  PROTOCOL_VERSION,
  SyncEvent,
} from '../contracts/protocol';
import type { RoomDurableObject } from '../src/rooms/room';
import { LOBBY_NAME } from '../src/rooms/lobby';
import { ACCESS_TOKEN_SECONDS } from '../src/auth/tokens';
import {
  MAX_FRAMES_PER_WINDOW,
  MAX_SOCKETS,
  OCCUPIED_CHECK_MS,
  RATE_WINDOW_MS,
  TOKEN_GRACE_MS,
} from '../src/rooms/room';
import type { RoomStore } from '../src/rooms/store';
import { CHUNK_BYTES } from '../src/rooms/store';
import { ORIGIN, freshIp } from './helpers';
import {
  ROOMS,
  connect,
  contextOf,
  createRoom,
  eventually,
  join,
  listRooms,
  postRoom,
  stubOf,
  upgrade,
  refusalOf,
} from './room-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const keysOf = (value: object) => Object.keys(value).sort();

/** 部屋の置き場所を、まとめておいた変更を書いてから読む */
const flushed = async <T>(roomKey: string, read: (sql: SqlStorage) => T): Promise<T> =>
  runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
    (instance as unknown as { store: RoomStore }).store.flush();
    return read(state.storage.sql);
  });

const countRows = (sql: SqlStorage, table: string) =>
  sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

describe('POST /v1/rooms', () => {
  it('opens a room and lists it in the lobby', async () => {
    const res = await postRoom({ name: 'ロビー' });

    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const body = await res.json<{ roomKey: string; roomId: string }>();
    expect(body.roomKey).toMatch(/^[0-9a-f]{32}$/);
    expect(body.roomId).toMatch(/^[0-9a-zA-Z]{3}$/);
    expect((await listRooms()).find((room) => room.roomKey === body.roomKey)).toEqual({
      roomKey: body.roomKey,
      roomId: body.roomId,
      name: 'ロビー',
      hasPassword: false,
      members: 0,
    });
  });

  it('keeps a password only as a hash, and says the room has one', async () => {
    const roomKey = await createRoom({ password: 'secret' });

    const listed = (await listRooms()).find((room) => room.roomKey === roomKey);
    expect(listed?.hasPassword).toBe(true);
    const row = await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      state.storage.sql
        .exec<{ password_hash: ArrayBuffer }>('SELECT password_hash FROM room')
        .one(),
    );
    expect(new TextDecoder().decode(row.password_hash)).not.toContain('secret');
  });

  it.each([
    ['no name', {}],
    ['an empty name', { name: '' }],
    ['a name that is too long', { name: 'x'.repeat(256) }],
    ['a password that is too long', { name: 'room', password: 'x'.repeat(65) }],
    ['a body that is not JSON', 'name=room'],
  ])('turns away %s', async (_name, body) => {
    const res = await postRoom(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-request' });
  });

  it('turns away a page that is not listed, preflight included', async () => {
    const elsewhere = { Origin: 'https://elsewhere.example' };
    const post = await postRoom({ name: 'room' }, elsewhere);
    const list = await exports.default.fetch(new Request(ROOMS, { headers: elsewhere }));
    const preflight = await exports.default.fetch(
      new Request(ROOMS, {
        method: 'OPTIONS',
        headers: { ...elsewhere, 'Access-Control-Request-Method': 'POST' },
      }),
    );

    for (const res of [post, list, preflight]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'origin-not-allowed' });
    }
  });

  it('lets a listed page send JSON', async () => {
    const res = await exports.default.fetch(
      new Request(ROOMS, {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,POST,PUT,DELETE');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
  });

  it('stops one address once it has opened its share of rooms', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await postRoom({ name: 'room' }, { 'CF-Connecting-IP': ip })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('GET /v1/rooms/:roomKey/ws', () => {
  it.each([
    ['a key in the wrong form', 'abc', {}, 400, 'invalid-id'],
    ['a request that is not a WebSocket', '0'.repeat(32), { Upgrade: '' }, 426, 'upgrade-required'],
    [
      'a page that is not listed',
      '0'.repeat(32),
      { Origin: 'https://x.example' },
      403,
      'origin-not-allowed',
    ],
  ])('turns away %s', async (_name, roomKey, headers, status, error) => {
    const res = await upgrade(roomKey, headers);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('tells a socket to a room that was never opened that there is no such room', async () => {
    expect(await refusalOf('0'.repeat(32))).toBe('room-not-found');
  });

  it('stops one address once it has connected its share of times', async () => {
    const roomKey = await createRoom();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await upgrade(roomKey, { 'CF-Connecting-IP': ip });
      res.webSocket?.accept();
      statuses.push(res.status);
    }
    expect(statuses).toEqual([101, 101, 101, 101, 101, 429]);
  });

  it('turns away a socket past the limit, counting ones that have not said hello', async () => {
    const roomKey = await createRoom();
    for (let i = 0; i < MAX_SOCKETS; i++) await connect(roomKey);

    expect(await refusalOf(roomKey)).toBe('room-full');
  });
});

describe('joining a room', () => {
  it('welcomes the first one in with the server as a peer and its catalog', async () => {
    const roomKey = await createRoom();

    const { welcome, catalog } = await join(roomKey, 'alice-room-1');

    expect(welcome).toEqual({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      peerId: 'alice-room-1',
      authorityPeerId: AUTHORITY_PEER_ID,
      role: 'pl',
      members: [],
      serverTime: expect.any(Number),
      assetToken: expect.any(String),
      assetTokenExpiresAt: expect.any(Number),
    });
    expect(keysOf(welcome)).toEqual(keysOf(messages.server.welcome));
    expect(catalog).toEqual([
      { eventName: SyncEvent.CATALOG, data: [], sendFrom: AUTHORITY_PEER_ID },
    ]);
  });

  it('tells those inside who came in, and the newcomer who is inside', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');

    const bob = await join(roomKey, 'bob');

    expect(bob.welcome.members).toEqual([{ peerId: 'alice', userId: 'user-alice', role: 'pl' }]);
    const joined = await alice.client.next('join');
    expect(joined).toEqual({
      type: 'join',
      member: { peerId: 'bob', userId: 'user-bob', role: 'pl' },
    });
    expect(keysOf(joined)).toEqual(keysOf(messages.server.join));
    expect(
      (
        await eventually(listRooms, (rooms) =>
          rooms.some((r) => r.roomKey === roomKey && r.members === 2),
        )
      ).find((room) => room.roomKey === roomKey)?.members,
    ).toBe(2);
  });

  it('tells those inside who went out', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');

    bob.client.close();

    const left = await alice.client.next('leave');
    expect(left).toEqual({ type: 'leave', peerId: 'bob' });
    // 閉じてきた人には閉じ返す
    expect(await bob.client.closed).toEqual({ code: 1000, reason: 'bye' });
    expect(keysOf(left)).toEqual(keysOf(messages.server.leave));
    const rooms = await eventually(listRooms, (all) =>
      all.some((r) => r.roomKey === roomKey && r.members === 1),
    );
    expect(rooms.find((room) => room.roomKey === roomKey)?.members).toBe(1);
  });

  it('lets in only those who know the password', async () => {
    const roomKey = await createRoom({ password: 'secret' });

    const { welcome } = await join(roomKey, 'alice', { password: 'secret' });
    const intruder = await connect(roomKey);
    intruder.hello('mallory', { password: 'guess' });
    const nobody = await connect(roomKey);
    nobody.hello('nobody');

    expect(welcome.peerId).toBe('alice');
    for (const client of [intruder, nobody]) {
      expect(await client.next('error')).toEqual({
        type: 'error',
        code: 'wrong-password',
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(await client.closed).toEqual({ code: CLOSE_CODE, reason: 'wrong-password' });
    }
  });

  it('handles what a client sends straight after hello, once it is in', async () => {
    const roomKey = await createRoom({ password: 'secret' });
    const client = await connect(roomKey);

    client.hello('hasty', { password: 'secret' });
    client.send({ type: 'time' });

    expect((await client.next('welcome')).peerId).toBe('hasty');
    await client.events();
    await client.next('time');
  });

  it('turns away a client of another protocol version, telling it the version spoken here', async () => {
    const roomKey = await createRoom();
    const client = await connect(roomKey);

    client.hello('alice', { protocolVersion: PROTOCOL_VERSION + 1, extra: 'field' });

    const error = await client.next('error');
    expect(error).toEqual(messages.server.error);
    expect(await client.closed).toEqual({ code: CLOSE_CODE, reason: 'protocol-mismatch' });
  });

  it.each([
    ['a first message that is not hello', { type: 'time' }, 'hello-required'],
    ['a hello with the server peer id', { peerId: AUTHORITY_PEER_ID }, 'bad-message'],
    ['a hello without a user id', { userId: 1 }, 'bad-message'],
  ])('turns away %s', async (_name, message, code) => {
    const roomKey = await createRoom();
    const client = await connect(roomKey);

    if ('type' in message) client.send(message);
    else client.hello('alice', message);

    expect((await client.next('error')).code).toBe(code);
    expect(await client.closed).toEqual({ code: CLOSE_CODE, reason: code });
  });

  it('turns away bytes that are not MessagePack, and gzip that swells too far', async () => {
    const roomKey = await createRoom();
    const garbled = await connect(roomKey);
    const bomb = await connect(roomKey);

    garbled.ws.send(new Uint8Array([0xc1]));
    bomb.ws.send(gzipSync(new Uint8Array(33 * 1024 * 1024)));

    for (const client of [garbled, bomb]) {
      expect((await client.next('error')).code).toBe('bad-message');
    }
  });

  it('reads a gzipped frame', async () => {
    const roomKey = await createRoom();
    const client = await connect(roomKey);

    client.send(
      { type: 'hello', protocolVersion: PROTOCOL_VERSION, peerId: 'alice', userId: 'u' },
      { gzip: true },
    );

    expect((await client.next('welcome')).peerId).toBe('alice');
  });

  it('turns away the one past the limit', async () => {
    const roomKey = await createRoom();
    for (let i = 0; i < MAX_MEMBERS; i++) await join(roomKey, `member-${i}`);

    const late = await connect(roomKey);
    late.hello('late');

    expect((await late.next('error')).code).toBe('room-full');
  });

  it('closes the older socket of a peer that connects again, without telling the others it left', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');

    const again = await join(roomKey, 'bob');

    expect(again.welcome.members).toEqual([{ peerId: 'alice', userId: 'user-alice', role: 'pl' }]);
    expect((await bob.client.next('error')).code).toBe('replaced');
    expect(await bob.client.closed).toEqual({ code: CLOSE_CODE, reason: 'replaced' });
    await alice.client.expectQuiet();
    again.client.emit([{ eventName: 'CHAT', data: 'still here' }]);
    expect(await alice.client.events()).toEqual([
      { eventName: 'CHAT', data: 'still here', sendFrom: 'bob' },
    ]);
  });

  it('answers ping with pong without a frame of its own, and closes on other text', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');

    client.ws.send('ping');
    expect((await client.nextRaw()).message).toBe('pong');
    await client.expectQuiet();

    client.ws.send('hello?');
    expect((await client.next('error')).code).toBe('bad-message');
  });

  it('tells the time, and ignores a second hello', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');

    client.hello('someone-else');
    client.send({ type: 'time' });

    const time = await client.next('time');
    expect(time.serverTime).toEqual(expect.any(Number));
    expect(keysOf(time)).toEqual(keysOf(messages.server.time));
  });

  it('turns away a message it cannot read once inside', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');

    bob.client.send({ type: 'send', events: {} });
    bob.client.emit([{ eventName: 'CHAT', data: 'too late' }]);

    expect((await bob.client.next('error')).code).toBe('bad-message');
    expect(await alice.client.next('leave')).toEqual({ type: 'leave', peerId: 'bob' });
    await alice.client.expectQuiet();
  });

  it('closes back with the code it was closed with, or 1000 for a code it cannot send', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');

    alice.client.ws.close(4000, 'later');
    bob.client.ws.close();

    expect(await alice.client.closed).toEqual({ code: 4000, reason: 'later' });
    expect((await bob.client.closed).code).toBe(1000);
  });

  it('counts an error on a socket as leaving, and the close after it as nothing more', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');

    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
      const ws = state
        .getWebSockets()
        .find((socket) => (socket.deserializeAttachment() as { peerId: string }).peerId === 'bob');
      instance.webSocketError(ws as WebSocket);
    });
    bob.client.close();

    expect(await alice.client.next('leave')).toEqual({ type: 'leave', peerId: 'bob' });
    await alice.client.expectQuiet();
  });

  it('cuts off a socket that sends too much, and counts afresh in the next window', async () => {
    const roomKey = await createRoom();
    const steady = await join(roomKey, 'steady');
    const noisy = await join(roomKey, 'noisy');
    await steady.client.next('join');

    // hello と、最後の time も数に入る
    for (let i = 0; i < MAX_FRAMES_PER_WINDOW - 2; i++) steady.client.emit([]);
    await steady.client.expectQuiet();
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
      const { rates } = instance as unknown as { rates: WeakMap<WebSocket, { start: number }> };
      const ws = state
        .getWebSockets()
        .find(
          (socket) => (socket.deserializeAttachment() as { peerId: string }).peerId === 'steady',
        );
      (rates.get(ws as WebSocket) as { start: number }).start -= RATE_WINDOW_MS;
    });
    await steady.client.expectQuiet();
    for (let i = 0; i < MAX_FRAMES_PER_WINDOW; i++) noisy.client.emit([]);

    expect((await noisy.client.next('error')).code).toBe('too-many-messages');
    expect(await steady.client.next('leave')).toEqual({ type: 'leave', peerId: 'noisy' });
  }, 90_000);
});

describe('relaying', () => {
  const room = async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    const carol = await join(roomKey, 'carol');
    await alice.client.next('join');
    await alice.client.next('join');
    await bob.client.next('join');
    return { roomKey, alice: alice.client, bob: bob.client, carol: carol.client };
  };

  it('hands a broadcast to everyone else under the true sender, and not back to it', async () => {
    const { alice, bob, carol } = await room();

    alice.send({
      type: 'send',
      events: [{ eventName: 'CURSOR_MOVE', data: [1, 2], sendFrom: 'carol' }],
    });

    const expected = [{ eventName: 'CURSOR_MOVE', data: [1, 2], sendFrom: 'alice' }];
    const delivered = await bob.next('data');
    expect(delivered).toEqual({ type: 'data', from: 'alice', events: expected });
    expect(keysOf(delivered)).toEqual(keysOf(messages.server.data));
    expect(await carol.events()).toEqual(expected);
    await alice.expectQuiet();
  });

  it('hands an addressed message to that peer only', async () => {
    const { alice, bob, carol } = await room();

    alice.emit([{ eventName: 'WHISPER', data: 'psst' }], 'bob');

    expect(await bob.events()).toEqual([{ eventName: 'WHISPER', data: 'psst', sendFrom: 'alice' }]);
    await carol.expectQuiet();
  });

  it('drops a message for a peer that is not here, or for the server', async () => {
    const { alice, bob } = await room();

    alice.emit([{ eventName: 'WHISPER', data: 'psst' }], 'nobody');
    alice.emit([{ eventName: 'WHISPER', data: 'psst' }], AUTHORITY_PEER_ID);
    alice.emit([{ eventName: 'WHISPER', data: 'psst' }], 'alice');

    await bob.expectQuiet();
  });

  it('spreads a change to everyone even inside an addressed batch, keeping the order', async () => {
    const { alice, bob, carol } = await room();

    alice.emit(
      [
        { eventName: 'WHISPER', data: 'before' },
        { eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) },
        { eventName: 'WHISPER', data: 'after' },
      ],
      'bob',
    );

    expect((await bob.events()).map((event) => event.eventName)).toEqual([
      'WHISPER',
      SyncEvent.UPDATE,
      'WHISPER',
    ]);
    expect((await carol.events()).map((event) => event.eventName)).toEqual([SyncEvent.UPDATE]);
  });

  it('sends a large frame that gzip does not shrink as it is', async () => {
    const { alice, bob } = await room();
    const noise = crypto.getRandomValues(new Uint8Array(4096));

    alice.emit([{ eventName: 'NOISE', data: noise }]);

    const { raw, message } = await bob.nextRaw();
    expect(new Uint8Array(raw as ArrayBuffer)[0]).not.toBe(0x1f);
    expect((message as { events: { data: unknown }[] }).events[0].data).toEqual(noise);
  });

  it('relays sync requests addressed to another peer instead of answering them', async () => {
    const { alice, bob } = await room();
    const sync = [
      { eventName: SyncEvent.CATALOG, data: [] },
      { eventName: SyncEvent.REQUEST, data: 'piece' },
      { eventName: SyncEvent.REQUEST_CATALOG, data: {} },
    ];

    alice.emit(sync, 'bob');

    expect(await bob.events()).toEqual(sync.map((event) => ({ ...event, sendFrom: 'alice' })));
    await alice.expectQuiet();
  });
});

describe('the state of the room', () => {
  const twoInRoom = async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');
    return { roomKey, alice: alice.client, bob: bob.client };
  };

  it('keeps a change and hands it to someone who comes in later', async () => {
    const { roomKey, alice, bob } = await twoInRoom();
    const piece = contextOf('piece', 3, 0.25, { name: 'goblin', hp: 7 });

    alice.emit([{ eventName: SyncEvent.UPDATE, data: piece }]);
    await bob.events();
    const carol = await join(roomKey, 'carol');
    carol.client.emit([{ eventName: SyncEvent.REQUEST, data: 'piece' }], AUTHORITY_PEER_ID);

    expect(carol.catalog).toEqual([
      {
        eventName: SyncEvent.CATALOG,
        data: [{ identifier: 'piece', version: 3.25 }],
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
    expect(await carol.client.events()).toEqual([
      { eventName: SyncEvent.UPDATE, data: piece, sendFrom: AUTHORITY_PEER_ID },
    ]);
  });

  it('sends the kept version back to a sender that changed an older one', async () => {
    const { alice, bob } = await twoInRoom();
    const newer = contextOf('piece', 4, 0.5);

    alice.emit([{ eventName: SyncEvent.UPDATE, data: newer }]);
    await bob.events();
    bob.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 3, 0.9) }]);

    expect(await bob.events()).toEqual([
      { eventName: SyncEvent.UPDATE, data: newer, sendFrom: AUTHORITY_PEER_ID },
    ]);
    await alice.expectQuiet();
  });

  it('does nothing with the version it already has', async () => {
    const { alice, bob } = await twoInRoom();
    const piece = contextOf('piece', 2, 0.5);

    alice.emit([{ eventName: SyncEvent.UPDATE, data: piece }]);
    await bob.events();
    bob.emit([{ eventName: SyncEvent.UPDATE, data: piece }]);

    await bob.expectQuiet();
    await alice.expectQuiet();
  });

  it('forgets a deleted object and has a late copy of it deleted again', async () => {
    const { roomKey, alice, bob } = await twoInRoom();

    alice.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) }]);
    await bob.events();
    alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'character', identifier: 'piece' } },
    ]);
    expect(await bob.events()).toEqual([
      {
        eventName: SyncEvent.DELETE,
        data: { aliasName: 'character', identifier: 'piece' },
        sendFrom: 'alice',
      },
    ]);
    bob.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 9, 0.5) }]);
    bob.emit([{ eventName: SyncEvent.CATALOG, data: [{ identifier: 'piece', version: 9.5 }] }]);
    bob.emit([{ eventName: SyncEvent.REQUEST, data: 'piece' }]);

    const deleteAgain = { eventName: SyncEvent.DELETE, sendFrom: AUTHORITY_PEER_ID };
    expect(await bob.events()).toEqual([
      { ...deleteAgain, data: { aliasName: 'character', identifier: 'piece' } },
    ]);
    expect(await bob.events()).toEqual([
      { ...deleteAgain, data: { aliasName: '', identifier: 'piece' } },
    ]);
    expect(await bob.events()).toEqual([
      { ...deleteAgain, data: { aliasName: '', identifier: 'piece' } },
    ]);
    await alice.expectQuiet();
    expect((await join(roomKey, 'carol')).catalog[0].data).toEqual([]);
  });

  it('takes a deleted object back once a loader says it is coming back', async () => {
    const { alice, bob } = await twoInRoom();
    alice.emit([{ eventName: SyncEvent.DELETE, data: { identifier: 'effect' } }]);
    await bob.events();

    alice.emit([
      { eventName: SyncEvent.FORGET_DELETED, data: { identifiers: ['effect', 'never-deleted'] } },
      { eventName: SyncEvent.UPDATE, data: contextOf('effect', 1, 0.5) },
    ]);

    expect((await bob.events()).map((event) => event.eventName)).toEqual([
      SyncEvent.FORGET_DELETED,
      SyncEvent.UPDATE,
    ]);
  });

  it('passes over sync events whose data it cannot read', async () => {
    const { alice, bob } = await twoInRoom();

    alice.emit([
      { eventName: SyncEvent.UPDATE, data: { identifier: 'piece' } },
      { eventName: SyncEvent.UPDATE, data: { ...contextOf('piece', 1, 0.5), syncData: [1] } },
      { eventName: SyncEvent.DELETE, data: 'piece' },
      { eventName: SyncEvent.FORGET_DELETED, data: 'piece' },
      { eventName: SyncEvent.CATALOG, data: { identifier: 'piece' } },
      { eventName: SyncEvent.REQUEST, data: 42 },
    ]);
    alice.emit([{ eventName: SyncEvent.FORGET_DELETED, data: {} }]);

    expect(await bob.events()).toEqual([
      { eventName: SyncEvent.FORGET_DELETED, data: {}, sendFrom: 'alice' },
    ]);
    await alice.expectQuiet();
  });

  it('asks a newcomer for what it holds that is newer or unknown here', async () => {
    const { alice, bob } = await twoInRoom();
    alice.emit([
      { eventName: SyncEvent.UPDATE, data: contextOf('old-here', 1, 0.5) },
      { eventName: SyncEvent.UPDATE, data: contextOf('new-here', 5, 0.5) },
      { eventName: SyncEvent.UPDATE, data: contextOf('same', 2, 0.5) },
    ]);
    await bob.events();

    bob.emit(
      [
        {
          eventName: SyncEvent.CATALOG,
          data: [
            { identifier: 'old-here', version: 2.5 },
            { identifier: 'new-here', version: 4.5 },
            { identifier: 'same', version: 2.5 },
            { identifier: 'unknown', version: 1.5 },
          ],
        },
      ],
      AUTHORITY_PEER_ID,
    );

    expect(await bob.events()).toEqual([
      { eventName: SyncEvent.REQUEST, data: 'old-here', sendFrom: AUTHORITY_PEER_ID },
      { eventName: SyncEvent.REQUEST, data: 'unknown', sendFrom: AUTHORITY_PEER_ID },
    ]);
  });

  it('answers a request for something it does not have with nothing', async () => {
    const { bob } = await twoInRoom();

    bob.emit([{ eventName: SyncEvent.REQUEST, data: 'nothing' }]);

    await bob.expectQuiet();
  });

  it('sends its whole catalog when asked, in batches the client reads', async () => {
    const { bob, alice } = await twoInRoom();
    const count = CATALOG_BATCH + 1;
    alice.emit(
      Array.from({ length: count }, (_, i) => ({
        eventName: SyncEvent.UPDATE,
        data: contextOf(`piece-${i}`, 1, 0.5, {}),
      })),
    );
    await bob.events();

    bob.emit([{ eventName: SyncEvent.REQUEST_CATALOG, data: {} }]);

    const { raw, message } = await bob.nextRaw();
    expect(new Uint8Array(raw as ArrayBuffer).subarray(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    const events = (message as { events: { data: unknown[] }[] }).events;
    expect(events.map((event) => event.data.length)).toEqual([CATALOG_BATCH, 1]);
  });

  describe('peer cursors', () => {
    const cursorOf = (peerId: string, majorVersion = 1) =>
      contextOf(
        `cursor-${peerId}`,
        majorVersion,
        0.5,
        { peerId, userId: `user-${peerId}`, name: peerId, role: 'pl' },
        'PeerCursor',
      );

    it('keeps a cursor while its peer is here, and drops it without a trace once the peer leaves', async () => {
      const { roomKey, alice, bob } = await twoInRoom();

      bob.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('bob') }]);
      await alice.events();
      expect((await join(roomKey, 'carol')).catalog[0].data).toEqual([
        { identifier: 'cursor-bob', version: 1.5 },
      ]);
      bob.close();
      await alice.next('join');
      await alice.next('leave');
      const rows = await flushed(roomKey, (sql) => countRows(sql, 'objects'));

      expect(rows).toBe(0);
      expect((await join(roomKey, 'dave')).catalog[0].data).toEqual([]);
    });

    it('takes no cursor of someone who is not here', async () => {
      const { alice, bob } = await twoInRoom();

      alice.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('ghost') }]);
      alice.emit([
        {
          eventName: SyncEvent.UPDATE,
          data: { ...cursorOf('alice'), syncData: { name: 'no id' } },
        },
      ]);

      await bob.expectQuiet();
    });

    it('takes away the cursor of a page its peer has come back from', async () => {
      const { roomKey, alice, bob } = await twoInRoom();
      bob.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('bob') }]);
      await alice.events();

      const again = await join(roomKey, 'bob');

      expect(await alice.events()).toEqual([
        {
          eventName: SyncEvent.DELETE,
          data: { aliasName: 'PeerCursor', identifier: 'cursor-bob' },
          sendFrom: AUTHORITY_PEER_ID,
        },
      ]);
      expect(again.catalog[0].data).toEqual([]);
    });

    it('clears away the cursor of someone who went without a word', async () => {
      const { roomKey, alice } = await twoInRoom();
      await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
        (instance as unknown as { store: RoomStore }).store.put(cursorOf('ghost'), 'ghost');
        return state.storage.setAlarm(Date.now() + 60_000);
      });

      expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
      expect(await alice.events()).toEqual([
        {
          eventName: SyncEvent.DELETE,
          data: { aliasName: 'PeerCursor', identifier: 'cursor-ghost' },
          sendFrom: AUTHORITY_PEER_ID,
        },
      ]);
    });

    it('leaves no tombstone for a cursor, so its peer can bring it back', async () => {
      const { roomKey, alice, bob } = await twoInRoom();
      bob.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('bob') }]);
      await alice.events();

      bob.emit([
        { eventName: SyncEvent.DELETE, data: { aliasName: '', identifier: 'cursor-bob' } },
      ]);
      alice.emit([
        { eventName: SyncEvent.DELETE, data: { aliasName: 'PeerCursor', identifier: 'cursor-x' } },
      ]);
      await alice.events();
      await bob.events();
      bob.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('bob', 2) }]);

      expect((await alice.events())[0].data).toEqual(cursorOf('bob', 2));
      expect(await flushed(roomKey, (sql) => countRows(sql, 'tombstones'))).toBe(0);
    });
  });
});

describe('keeping the room', () => {
  it('writes changes together, after a short wait', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');

    for (let i = 1; i <= 5; i++) {
      client.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', i, 0.5) }]);
    }
    await client.expectQuiet();
    const before = await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      countRows(state.storage.sql, 'objects'),
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      state.storage.sql.exec<{ major: number }>('SELECT major FROM objects').toArray(),
    );

    expect(before).toBe(0);
    expect(after).toEqual([{ major: 5 }]);
  });

  it('comes back from hibernation with its members and its state', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const big = { scene: 'x'.repeat(CHUNK_BYTES + 10) };
    alice.client.emit([
      { eventName: SyncEvent.UPDATE, data: contextOf('board', 1, 0.5, big, 'white-board') },
      { eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) },
      { eventName: SyncEvent.DELETE, data: { identifier: 'gone' } },
    ]);
    await alice.client.expectQuiet();
    const chunks = await flushed(roomKey, (sql) => countRows(sql, 'object_chunks'));

    await evictDurableObject(stubOf(roomKey));
    const bob = await join(roomKey, 'bob');
    bob.client.emit(
      [
        { eventName: SyncEvent.REQUEST, data: 'board' },
        { eventName: SyncEvent.REQUEST, data: 'piece' },
        { eventName: SyncEvent.REQUEST, data: 'gone' },
      ],
      AUTHORITY_PEER_ID,
    );

    expect(chunks).toBe(2);
    expect(bob.welcome.members).toEqual([{ peerId: 'alice', userId: 'user-alice', role: 'pl' }]);
    expect(bob.catalog[0].data).toEqual(
      expect.arrayContaining([
        { identifier: 'board', version: 1.5 },
        { identifier: 'piece', version: 1.5 },
      ]),
    );
    const answers = await bob.client.events();
    expect(answers[0].data).toEqual(contextOf('board', 1, 0.5, big, 'white-board'));
    expect(answers[1].data).toEqual(contextOf('piece', 1, 0.5));
    expect(answers[2]).toEqual({
      eventName: SyncEvent.DELETE,
      data: { aliasName: '', identifier: 'gone' },
      sendFrom: AUTHORITY_PEER_ID,
    });
    expect(await alice.client.next('join')).toEqual({
      type: 'join',
      member: { peerId: 'bob', userId: 'user-bob', role: 'pl' },
    });
  });

  it('rewrites a large object in place and deletes its pieces with it', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');
    const big = { scene: 'x'.repeat(2 * CHUNK_BYTES + 10) };

    client.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('board', 1, 0.5, big) }]);
    await client.expectQuiet();
    const first = await flushed(roomKey, (sql) => countRows(sql, 'object_chunks'));
    client.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('board', 2, 0.5, { scene: '' }) }]);
    await client.expectQuiet();
    const second = await flushed(roomKey, (sql) => countRows(sql, 'object_chunks'));
    client.emit([
      { eventName: SyncEvent.FORGET_DELETED, data: { identifiers: ['board'] } },
      { eventName: SyncEvent.DELETE, data: { identifier: 'board' } },
    ]);
    await client.expectQuiet();
    const third = await flushed(roomKey, (sql) => [
      countRows(sql, 'objects'),
      countRows(sql, 'tombstones'),
    ]);
    client.emit([{ eventName: SyncEvent.FORGET_DELETED, data: { identifiers: ['board'] } }]);
    await client.expectQuiet();
    const fourth = await flushed(roomKey, (sql) => countRows(sql, 'tombstones'));

    expect([first, second, third, fourth]).toEqual([3, 0, [0, 1], 0]);
  });
});

/** 部屋が空になった時刻と、時計が鳴る時刻 */
const clockOf = (roomKey: string) =>
  runInDurableObject(stubOf(roomKey), async (_instance, state) => ({
    emptiedAt: state.storage.sql
      .exec<{ emptied_at: number | null }>('SELECT emptied_at FROM room')
      .one().emptied_at,
    alarm: await state.storage.getAlarm(),
  }));

describe('closing the room', () => {
  it('deletes the room once the last one has been gone for the retention', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');
    client.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) }]);
    await client.expectQuiet();
    const occupied = await clockOf(roomKey);

    client.close();
    const emptied = await eventually(
      () => clockOf(roomKey),
      (clock) => clock.emptiedAt !== null,
    );
    const ran = await runDurableObjectAlarm(stubOf(roomKey));

    // 人がいるあいだの時計は見回り。ログインした席のトークンが先に切れるなら、そのころに見る
    expect(occupied.emptiedAt).toBeNull();
    expect(occupied.alarm).toBeGreaterThan(Date.now() + ACCESS_TOKEN_SECONDS * 1000 - 60_000);
    expect(occupied.alarm).toBeLessThan(Date.now() + OCCUPIED_CHECK_MS);
    expect(emptied.alarm).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(ran).toBe(true);
    expect((await listRooms()).some((room) => room.roomKey === roomKey)).toBe(false);
    expect(await refusalOf(roomKey)).toBe('room-not-found');
  });

  it('lets out a seat whose login ran out though nobody sends anything, and keeps the room', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');
    await runInDurableObject(stubOf(roomKey), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const seat = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...seat, expiresAt: Date.now() - TOKEN_GRACE_MS - 1 });
      }
    });

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);

    expect((await client.next('error')).code).toBe('unauthorized');
    const clock = await clockOf(roomKey);
    expect(clock.emptiedAt).not.toBeNull();
    expect(clock.alarm).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it('deletes a room nobody entered', async () => {
    const roomKey = await createRoom();
    const early = await connect(roomKey);

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    early.hello('alice');

    expect((await early.next('error')).code).toBe('room-not-found');
  });

  it('keeps a room someone is in, and looks again later', async () => {
    const roomKey = await createRoom();
    await join(roomKey, 'alice', { accessToken: null });
    await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    expect((await listRooms()).find((room) => room.roomKey === roomKey)?.members).toBe(1);
    expect((await clockOf(roomKey)).alarm).toBeGreaterThan(Date.now() + OCCUPIED_CHECK_MS - 60_000);
  });

  it('counts afresh a room left without anyone seen going out, and deletes it after the retention', async () => {
    // Worker が落ちて、出ていく知らせが来ないまま、つながっていた人がいなくなった部屋
    const roomKey = await createRoom();
    await runInDurableObject(stubOf(roomKey), (_instance, state) => {
      state.storage.sql.exec('UPDATE room SET emptied_at = NULL');
    });
    await env.LOBBY.getByName(LOBBY_NAME).setMembers(roomKey, 2);

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    const counted = await eventually(listRooms, (all) =>
      all.some((room) => room.roomKey === roomKey && room.members === 0),
    );
    const clock = await clockOf(roomKey);
    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);

    expect(counted.some((room) => room.roomKey === roomKey)).toBe(true);
    expect(clock.emptiedAt).not.toBeNull();
    expect(clock.alarm).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect((await listRooms()).some((room) => room.roomKey === roomKey)).toBe(false);
  });

  it('cleans up a store that never became a room', async () => {
    const stub = env.ROOMS.getByName('f'.repeat(32));
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });
});

describe('the lobby', () => {
  it('goes on counting after a failed update', async () => {
    const roomKey = await createRoom();
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      const broken = { getByName: () => ({ setMembers: () => Promise.reject(new Error('down')) }) };
      (instance as unknown as { env: Env }).env = { ...env, LOBBY: broken } as unknown as Env;
    });

    await join(roomKey, 'alice');

    await eventually(
      async () => failure.mock.calls.length,
      (calls) => calls > 0,
    );
    expect(failure).toHaveBeenCalledWith('Lobby update failed:', expect.any(Error));
  });
});
