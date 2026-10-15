import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorityEvent } from '../contracts/protocol';
import type { ErrorMessage, RoomSummary } from '../contracts/protocol';
import app from '../src/index';
import type { RoomDurableObject } from '../src/rooms/room';
import { ORIGIN, accessTokenFor, freshIp } from './helpers';
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
  stubOf,
} from './room-helpers';

// GM が部屋を削除するときと、一覧で削除できる部屋に印を付けるとき

afterEach(() => {
  vi.restoreAllMocks();
});

/** 部屋を削除する API を呼ぶ。userId が null ならログインせずに */
const deleteRoom = (roomKey: string, userId: string | null, ip = freshIp()) =>
  exports.default.fetch(
    new Request(`${ROOMS}/${roomKey}`, {
      method: 'DELETE',
      headers: {
        Origin: ORIGIN,
        'CF-Connecting-IP': ip,
        ...(userId === null ? {} : { Authorization: `Bearer ${accessTokenFor(userId)}` }),
      },
    }),
  );

/** アクセストークンを付けて一覧を取る */
const listAs = async (authorization: string): Promise<RoomSummary[]> => {
  const res = await exports.default.fetch(
    new Request(ROOMS, {
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), Authorization: authorization },
    }),
  );
  return (await res.json<{ rooms: RoomSummary[] }>()).rooms;
};
const listFor = (userId: string) => listAs(`Bearer ${accessTokenFor(userId)}`);
const rowOf = <T extends { roomKey: string }>(rooms: T[], roomKey: string) =>
  rooms.find((room) => room.roomKey === roomKey);

/** 次に届いた error。そこまでに届いたほかのものは読み捨てる */
const errorOf = async (client: Client): Promise<ErrorMessage> => {
  for (;;) {
    const { message } = await client.nextRaw();
    if (typeof message !== 'string' && message.type === 'error') return message;
  }
};

/** 部屋に置いたものが、表ごと残っていないこと */
const tablesOf = (roomKey: string) =>
  runInDurableObject(stubOf(roomKey), (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room', 'seats', 'objects')",
      )
      .toArray()
      .map((row) => row.name),
  );

const promote = (gm: Client, peerId: string, role: string) =>
  gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId, role } }]);

describe('deleting a room', () => {
  it('lets its GM delete it, and closes everybody in it', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    const guest = await join(roomKey, 'guest', { accessToken: null });
    const silent = await connect(roomKey);

    const res = await deleteRoom(roomKey, 'user-gm');

    expect(res.status).toBe(204);
    for (const client of [gm.client, pl.client, guest.client, silent]) {
      expect((await errorOf(client)).code).toBe('room-deleted');
      expect(await client.closed).toEqual({ code: 4000, reason: 'room-deleted' });
    }
    expect(rowOf(await listRooms(), roomKey)).toBeUndefined();
    expect(await tablesOf(roomKey)).toEqual([]);
    expect(
      await runInDurableObject(stubOf(roomKey), (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
    expect(await refusalOf(roomKey)).toBe('room-not-found');
  });

  it('lets a GM made by another GM delete it too', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    await join(roomKey, 'pl');
    await gm.client.next('join');
    promote(gm.client, 'pl', 'gm');
    await gm.client.expectQuiet();

    expect((await deleteRoom(roomKey, 'user-pl')).status).toBe(204);
  });

  it('keeps it for anybody who is not its GM', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    await join(roomKey, 'pl');
    await gm.client.next('join');

    const player = await deleteRoom(roomKey, 'user-pl');
    const stranger = await deleteRoom(roomKey, 'user-stranger');

    expect(player.status).toBe(403);
    expect(await player.json()).toEqual({ error: 'not-game-master' });
    expect(stranger.status).toBe(403);
    expect(rowOf(await listRooms(), roomKey)).toBeDefined();
    await gm.client.expectQuiet();
  });

  it('asks for login', async () => {
    const roomKey = await createRoom();

    const res = await deleteRoom(roomKey, null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'login-required' });
  });

  it('turns away a key that cannot be a room, and a room that is not there', async () => {
    const malformed = await deleteRoom('not-a-key', HOST);
    const missing = await deleteRoom('a'.repeat(32), HOST);

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid-id' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'room-not-found' });
  });

  it('stops one address that deletes too often', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await deleteRoom('b'.repeat(32), HOST, ip)).status);

    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
  });

  it('is not offered on a Worker without login', async () => {
    const res = await app.fetch(
      new Request(`${ROOMS}/${'c'.repeat(32)}`, { method: 'DELETE', headers: { Origin: ORIGIN } }),
      {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
      },
      createExecutionContext(),
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'login-unavailable' });
  });

  it('takes nobody in and hands out nothing while it is being deleted', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const late = await connect(roomKey);
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      (instance as unknown as { wiping: boolean }).wiping = true;
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

    expect(failure).toHaveBeenCalledWith(
      'Room deletion failed, to be tried again:',
      expect.any(Error),
    );
    expect(await refusalOf(roomKey)).toBe('room-not-found');
    expect((await deleteRoom(roomKey, 'user-gm')).status).toBe(404);
    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);
    expect(rowOf(await listFor('user-gm'), roomKey)).toBeUndefined();
    expect(
      await runInDurableObject(stubOf(roomKey), (_instance, state) =>
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name IN ('room', 'deleting')")
          .toArray(),
      ),
    ).toEqual([]);
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
      (instance as unknown as { rollQueue: Promise<void> }).rollQueue = new Promise<void>(
        (resolve) => {
          release = resolve;
        },
      );
    });
    const pending = () =>
      runInDurableObject(
        stubOf(roomKey),
        (instance: RoomDurableObject) =>
          (instance as unknown as { pendingRolls: number }).pendingRolls,
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
    // 部屋の中で作った約束なので、部屋の中で解く
    await runInDurableObject(stubOf(roomKey), () => release());
    await eventually(pending, (count) => count === 0);

    expect(failure).not.toHaveBeenCalled();
    expect(await tablesOf(roomKey)).toEqual([]);
  });

  it('tells the lobby nothing more once the room is gone', async () => {
    const roomKey = await createRoom();
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runInDurableObject(stubOf(roomKey), async (instance: RoomDurableObject) => {
      const room = instance as unknown as {
        lobbyQueue: Promise<void>;
        notifyLobby(roomKey: string): void;
      };
      let release: () => void = () => undefined;
      room.lobbyQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      room.notifyLobby(roomKey);
      expect(await instance.deleteRoom(HOST)).toBe('deleted');
      release();
      await room.lobbyQueue;
    });

    expect(failure).not.toHaveBeenCalled();
    expect(rowOf(await listFor(HOST), roomKey)).toBeUndefined();
  });
});

describe('the room list', () => {
  it('marks the rooms whose GM asks for it', async () => {
    const mine = await createRoom({}, 'me');
    const theirs = await createRoom({}, 'them');

    const rooms = await listFor('user-me');
    const anonymous = await listRooms();

    expect(rowOf(rooms, mine)?.deletable).toBe(true);
    expect(rowOf(rooms, theirs)).not.toHaveProperty('deletable');
    expect(rowOf(anonymous, mine)).not.toHaveProperty('deletable');
  });

  it('follows a GM role as it is given and taken back', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    await join(roomKey, 'pl');
    await gm.client.next('join');

    promote(gm.client, 'pl', 'gm');
    const given = await eventually(
      () => listFor('user-pl'),
      (rooms) => rowOf(rooms, roomKey)?.deletable === true,
    );
    promote(gm.client, 'pl', 'pl');
    const taken = await eventually(
      () => listFor('user-pl'),
      (rooms) => rowOf(rooms, roomKey)?.deletable === undefined,
    );

    expect(rowOf(given, roomKey)?.deletable).toBe(true);
    expect(rowOf(taken, roomKey)).not.toHaveProperty('deletable');
  });

  it('marks a room for somebody who came in by a GM invitation', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    gm.client.send({ type: 'invite', role: 'gm' });
    const { invite } = await gm.client.next('invite');

    await join(roomKey, 'co-gm', { invite });
    const rooms = await eventually(
      () => listFor('user-co-gm'),
      (listed) => rowOf(listed, roomKey)?.deletable === true,
    );

    expect(rowOf(rooms, roomKey)?.deletable).toBe(true);
  });

  it('lists without marks for a token it cannot read', async () => {
    const roomKey = await createRoom();

    const rooms = await listAs('Bearer not-a-token');

    expect(rowOf(rooms, roomKey)).toBeDefined();
    expect(rooms.some((room) => 'deletable' in room)).toBe(false);
  });

  it('lists the newest rooms first, and always the rooms one may delete', async () => {
    const roomKey = await createRoom({}, 'old-gm');
    const lobby = env.LOBBY.getByName('lobby');
    // 一覧に入りきらないほど、あとから部屋が作られた
    await runInDurableObject(lobby, (_instance, state) => {
      for (let i = 0; i < 1000; i++) {
        state.storage.sql.exec(
          `INSERT INTO rooms (room_key, room_id, name, has_password, members, created_at)
           VALUES (?, 'abc', 'newer', 0, 0, ?)`,
          `newer-${i}`,
          Date.now() + 1000 + i,
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
    } finally {
      await runInDurableObject(lobby, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM rooms WHERE room_key LIKE 'newer-%'");
      });
    }
  });

  it('stops one address that asks for the list too often', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await exports.default.fetch(
        new Request(ROOMS, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('lists the rooms of a Worker without login', async () => {
    const res = await app.fetch(
      new Request(ROOMS, { headers: { Origin: ORIGIN } }),
      {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
      },
      createExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: expect.any(Array) });
  });
});
