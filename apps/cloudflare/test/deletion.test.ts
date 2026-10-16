import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorityEvent } from '../contracts/protocol';
import type { ErrorMessage, RoomSummary } from '../contracts/protocol';
import { WIPE_RETRY_MS } from '../src/rooms/room';
import type { RoomDurableObject } from '../src/rooms/room';
import { ORIGIN, accessTokenFor, freshIp } from './shared/helpers';
import {
  chatTabList,
  Client,
  connect,
  contextOf,
  createRoom,
  eventually,
  HOST,
  join,
  listedTabOf,
  listRooms,
  refusalOf,
  ROOMS,
} from './shared/room-helpers';
import { stubOf } from './cf-helpers';

// A GM deleting a room, and the list marking the rooms that can be deleted.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Calls the API that deletes a room. Without logging in when userId is null. */
const deleteRoom = (roomKey: string, userId: string | null, ip = freshIp()) =>
  exports.default.fetch(
    new Request(`${ROOMS}/${roomKey}`, {
      method: 'DELETE',
      headers: {
        Origin: ORIGIN,
        'CF-Connecting-IP': ip,
        ...(userId === null ? {} : { Authorization: `Bearer ${accessTokenFor(userId)}` }),
      },
    })
  );

/** Gets the room list with an access token. */
const listAs = async (authorization: string): Promise<RoomSummary[]> => {
  const res = await exports.default.fetch(
    new Request(ROOMS, {
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), Authorization: authorization },
    })
  );
  return (await res.json<{ rooms: RoomSummary[] }>()).rooms;
};
const listFor = (userId: string) => listAs(`Bearer ${accessTokenFor(userId)}`);
const rowOf = <T extends { roomKey: string }>(rooms: T[], roomKey: string) =>
  rooms.find((room) => room.roomKey === roomKey);

/** The next error to arrive. Anything else that arrives before it is read and thrown away. */
const errorOf = async (client: Client): Promise<ErrorMessage> => {
  for (;;) {
    const { message } = await client.nextRaw();
    if (typeof message !== 'string' && message.type === 'error') return message;
  }
};

/** That none of what the room kept is left, tables and all. */
const tablesOf = (roomKey: string) =>
  runInDurableObject(stubOf(roomKey), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room', 'seats', 'objects')"
      )
      .toArray()
      .map((row) => row.name)
  );

describe('deleting a room', () => {
  it('leaves nothing of the room in its storage, and no clock', async () => {
    const roomKey = await createRoom({}, 'gm');
    await join(roomKey, 'gm');

    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(204);

    expect(await tablesOf(roomKey)).toEqual([]);
    expect(await runInDurableObject(stubOf(roomKey), (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('takes nobody in and hands out nothing while it is being deleted', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const late = await connect(roomKey);
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      (instance as unknown as { deleting: boolean }).deleting = true;
    });

    late.hello('late');
    gm.client.send({ type: 'asset-token' });

    expect((await late.next('error')).code).toBe('room-not-found');
    expect((await gm.client.next('error')).code).toBe('room-deleted');
    expect(await refusalOf(roomKey)).toBe('room-not-found');
    expect(await stubOf(roomKey).canUpload('user-gm')).toBe('room-not-found');
    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(404);
  });

  it('keeps a room it could not finish deleting gone, and finishes it on its own', async () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const roomKey = await createRoom({}, 'gm');
    await join(roomKey, 'gm');
    let unlisted = false;
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      const room = instance as unknown as {
        lobby: () => { remove: (key: string) => Promise<void> };
      };
      const lobby = room.lobby.bind(instance);
      room.lobby = () => ({
        remove: async (key: string) => {
          if (!unlisted) {
            unlisted = true;
            throw new Error('lobby unreachable');
          }
          await lobby().remove(key);
        },
      });
    });

    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(204);

    expect(failure).toHaveBeenCalledWith('Room deletion failed, to be tried again:', expect.any(Error));
    expect(await refusalOf(roomKey)).toBe('room-not-found');
    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(404);
    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    expect(rowOf(await listFor('user-gm'), roomKey)).toBeUndefined();
    expect(
      await runInDurableObject(stubOf(roomKey), (_instance, state) =>
        state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('room', 'deleting')").toArray()
      )
    ).toEqual([]);
  });

  it('sets the clock that finishes the deleting before it asks anything outside the room', async () => {
    const roomKey = await createRoom({}, 'gm');
    await join(roomKey, 'gm');
    let unlist: () => void = () => undefined;
    const asked = new Promise<void>((resolveAsked) => {
      void runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
        const room = instance as unknown as {
          lobby: () => { remove: (key: string) => Promise<void> };
        };
        const lobby = room.lobby.bind(instance);
        room.lobby = () => ({
          remove: (key: string) => {
            resolveAsked();
            return new Promise<void>((resolve) => {
              unlist = () => void lobby().remove(key).then(resolve);
            });
          },
        });
      });
    });

    const deleted = deleteRoom(roomKey, 'user-gm');
    await asked;
    const alarm = await runInDurableObject(stubOf(roomKey), (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
    expect(alarm).toBeLessThanOrEqual(Date.now() + WIPE_RETRY_MS);

    // Even when that alarm goes off first, it does not start a second deletion while one is going, and
    // comes back.
    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    expect(await runInDurableObject(stubOf(roomKey), (_instance, state) => state.storage.getAlarm())).not.toBeNull();

    unlist();
    expect((await deleted).status).toBe(204);
    expect(rowOf(await listFor('user-gm'), roomKey)).toBeUndefined();
  });

  it('tells nothing to a socket already counted as gone', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    await gm.client.next('join');
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) => {
      const ws = state
        .getWebSockets()
        .find((socket) => (socket.deserializeAttachment() as { peerId: string }).peerId === 'pl');
      instance.webSocketError(ws as WebSocket);
    });

    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(204);

    expect((await errorOf(gm.client)).code).toBe('room-deleted');
    await pl.client.expectQuiet();
    pl.client.close();
  });

  it('puts nothing in place for a roll that finishes after the room is gone', async () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    let release: () => void = () => undefined;
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      (instance as unknown as { engine: { rollQueue: Promise<void> } }).engine.rollQueue = new Promise<void>(
        (resolve) => {
          release = resolve;
        }
      );
    });
    const pending = () =>
      runInDurableObject(
        stubOf(roomKey),
        (instance: RoomDurableObject) =>
          (instance as unknown as { engine: { pendingRolls: number } }).engine.pendingRolls
      );
    gm.client.emit([
      { eventName: 'UPDATE_GAME_OBJECT', data: chatTabList() },
      { eventName: 'UPDATE_GAME_OBJECT', data: listedTabOf('main') },
      {
        eventName: AuthorityEvent.ROLL_REQUEST,
        data: {
          message: contextOf('late', 1, 0.5, { parentIdentifier: 'main', value: '' }, 'chat'),
          command: '1d1',
          gameSystem: 'DiceBot',
          speaker: 'GM',
        },
      },
    ]);
    await eventually(pending, (count) => count === 1);

    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(204);
    // The promise was made inside the room, so it is resolved inside the room.
    await runInDurableObject(stubOf(roomKey), () => release());
    await eventually(pending, (count) => count === 0);

    expect(failure).not.toHaveBeenCalled();
    expect(await tablesOf(roomKey)).toEqual([]);
  });

  it('tells the lobby nothing more once the room is gone', async () => {
    const roomKey = await createRoom();
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runInDurableObject(stubOf(roomKey), async (instance: RoomDurableObject) => {
      const room = instance as unknown as { lobbyQueue: Promise<void> };
      let release: () => void = () => undefined;
      room.lobbyQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      instance.lobbyChanged(roomKey);
      expect(await instance.deleteRoom(HOST)).toBe('deleted');
      release();
      await room.lobbyQueue;
    });

    expect(failure).not.toHaveBeenCalled();
    expect(rowOf(await listFor(HOST), roomKey)).toBeUndefined();
  });
});

describe('the room list', () => {
  it('lists the newest rooms first, and always the rooms one may delete', async () => {
    const roomKey = await createRoom({}, 'old-gm');
    const lobby = env.LOBBY.getByName('lobby');
    // More rooms than the list can hold were made afterwards.
    await runInDurableObject(lobby, (_instance, state) => {
      for (let i = 0; i < 1000; i++) {
        state.storage.sql.exec(
          `INSERT INTO rooms (room_key, room_id, name, has_password, members, created_at)
           VALUES (?, 'abc', 'newer', 0, 0, ?)`,
          `newer-${i}`,
          Date.now() + 1000 + i
        );
      }
    });

    try {
      const anybody = await listRooms();
      const mine = await listFor('user-old-gm');
      expect(anybody).toHaveLength(1000);
      expect(rowOf(anybody, roomKey)).toBeUndefined();
      expect(anybody[0].roomKey).toBe('newer-999');
      expect(rowOf(mine, roomKey)?.deletable).toBe(true);
      // Even when it is not in the list, it can be looked up by key.
      const found = await exports.default.fetch(
        new Request(`${ROOMS}/${roomKey}`, {
          headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp() },
        })
      );
      expect(found.status).toBe(200);
      expect((await found.json<{ room: RoomSummary }>()).room).toMatchObject({
        roomKey,
        name: expect.any(String),
      });
    } finally {
      await runInDurableObject(lobby, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM rooms WHERE room_key LIKE 'newer-%'");
      });
    }
  });
});
