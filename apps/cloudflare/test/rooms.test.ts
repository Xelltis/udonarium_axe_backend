import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTHORITY_PEER_ID, SyncEvent } from '../contracts/protocol';
import type { RoomDurableObject } from '../src/rooms/room';
import { LOBBY_NAME } from '../src/rooms/lobby';
import { ACCESS_TOKEN_SECONDS } from '../src/core/auth/tokens';
import { IDLE_MS, OCCUPIED_CHECK_MS, TOKEN_GRACE_MS } from '../src/core/rooms/limits';
import { CHUNK_BYTES } from '../src/rooms/store';
import { connect, contextOf, createRoom, eventually, join, listRooms, refusalOf } from './shared/room-helpers';
import { stubOf } from './cf-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Reads the room's store after writing the gathered changes. */
const flushed = async <T>(roomKey: string, read: (sql: SqlStorage) => T): Promise<T> =>
  runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
    instance.store().flush();
    return read(state.storage.sql);
  });

const countRows = (sql: SqlStorage, table: string) =>
  sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

describe('joining a room', () => {
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
});

describe('peer cursors', () => {
  const twoInRoom = async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');
    return { roomKey, alice: alice.client, bob: bob.client };
  };
  const cursorOf = (peerId: string, majorVersion = 1) =>
    contextOf(
      `cursor-${peerId}`,
      majorVersion,
      0.5,
      { peerId, userId: `user-${peerId}`, name: peerId, role: 'pl' },
      'PeerCursor'
    );

  it('clears away the cursor of someone who went without a word', async () => {
    const { roomKey, alice } = await twoInRoom();
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
      instance.store().put(cursorOf('ghost'), 'ghost');
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
      countRows(state.storage.sql, 'objects')
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      state.storage.sql.exec<{ major: number }>('SELECT major FROM objects').toArray()
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
      AUTHORITY_PEER_ID
    );

    expect(chunks).toBe(2);
    expect(bob.welcome.members).toEqual([{ peerId: 'alice', userId: 'user-alice', role: 'pl' }]);
    expect(bob.catalog[0].data).toEqual(
      expect.arrayContaining([
        { identifier: 'board', version: 1.5 },
        { identifier: 'piece', version: 1.5 },
      ])
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
    const third = await flushed(roomKey, (sql) => [countRows(sql, 'objects'), countRows(sql, 'tombstones')]);
    client.emit([{ eventName: SyncEvent.FORGET_DELETED, data: { identifiers: ['board'] } }]);
    await client.expectQuiet();
    const fourth = await flushed(roomKey, (sql) => countRows(sql, 'tombstones'));

    expect([first, second, third, fourth]).toEqual([3, 0, [0, 1], 0]);
  });
});

/** When the room became empty, and when the alarm goes off. */
const clockOf = (roomKey: string) =>
  runInDurableObject(stubOf(roomKey), async (_instance, state) => ({
    emptiedAt: state.storage.sql.exec<{ emptied_at: number | null }>('SELECT emptied_at FROM room').one().emptied_at,
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
      (clock) => clock.emptiedAt !== null
    );
    const ran = await runDurableObjectAlarm(stubOf(roomKey));

    // While people are in the room, the alarm is for checks. When the token of a logged-in seat runs
    // out sooner, the check comes around then.
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

  it('checks around when a seat would be left alone for long enough, and lets it out then', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice', { accessToken: null, idleMs: IDLE_MS - 10 * 60_000 });

    // A guest has no token to run out, so the check comes when the seat would be idle.
    const occupied = await clockOf(roomKey);
    expect(occupied.alarm).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(occupied.alarm).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);

    await runInDurableObject(stubOf(roomKey), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const seat = ws.deserializeAttachment() as Record<string, unknown>;
        ws.serializeAttachment({ ...seat, activeAt: Date.now() - IDLE_MS - 1 });
      }
    });
    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);

    expect((await client.next('error')).code).toBe('idle');
    expect((await clockOf(roomKey)).emptiedAt).not.toBeNull();
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
    await runInDurableObject(stubOf(roomKey), (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    expect((await listRooms()).find((room) => room.roomKey === roomKey)?.members).toBe(1);
    expect((await clockOf(roomKey)).alarm).toBeGreaterThan(Date.now() + OCCUPIED_CHECK_MS - 60_000);
  });

  it('counts afresh a room left without anyone seen going out, and deletes it after the retention', async () => {
    // A room whose connected people are gone after the Worker went down, with no word of their leaving.
    const roomKey = await createRoom();
    await runInDurableObject(stubOf(roomKey), (_instance, state) => {
      state.storage.sql.exec('UPDATE room SET emptied_at = NULL');
    });
    await env.LOBBY.getByName(LOBBY_NAME).setMembers(roomKey, 2);

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    const counted = await eventually(listRooms, (all) =>
      all.some((room) => room.roomKey === roomKey && room.members === 0)
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
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));

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
      (calls) => calls > 0
    );
    expect(failure).toHaveBeenCalledWith('Lobby update failed:', expect.any(Error));
  });
});

describe('what a room’s assets take up', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);

  it('is counted once from the listing, then as assets come and go, each once', async () => {
    const room = stubOf(await createRoom());

    expect(await room.assetBytes()).toBeNull();
    // Before it is counted, nothing is kept: the listing will find it.
    await room.keepAsset(B, 3);
    await room.dropAsset(B);
    expect(await room.assetBytes()).toBeNull();
    expect(await room.countAssetBytes([{ id: A, size: 10 }])).toBe(10);
    expect(await room.countAssetBytes([{ id: B, size: 99 }])).toBe(10);

    // Stored twice at once, or taken out twice at once: counted once each way.
    await room.keepAsset(B, 5);
    await room.keepAsset(B, 5);
    expect(await room.assetBytes()).toBe(15);
    await room.dropAsset(A);
    await room.dropAsset(A);
    expect(await room.assetBytes()).toBe(5);
  });

  it('keeps nothing for a room that is not there', async () => {
    const missing = stubOf('d'.repeat(32));

    expect(await missing.countAssetBytes([{ id: A, size: 7 }])).toBe(7);
    await missing.keepAsset(A, 7);
    await missing.dropAsset(A);
    expect(await missing.assetBytes()).toBeNull();
  });
});
