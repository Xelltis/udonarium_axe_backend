import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorityEvent } from '../../contracts/protocol.js';
import type { ErrorMessage, RoomSummary } from '../../contracts/protocol.js';
import { harness } from '../harness.js';
import { ORIGIN, accessTokenFor, freshIp, jsonOf } from './helpers.js';
import {
  Client,
  connect,
  createRoom,
  eventually,
  HOST,
  join,
  listRooms,
  refusalOf,
  ROOMS,
} from './room-helpers.js';

// GM が部屋を削除するときと、一覧で削除できる部屋に印を付けるとき

afterEach(() => {
  vi.restoreAllMocks();
});

/** 部屋を削除する API を呼ぶ。userId が null ならログインせずに */
const deleteRoom = (roomKey: string, userId: string | null, ip = freshIp()) =>
  harness.fetch(
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
  const res = await harness.fetch(
    new Request(ROOMS, {
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), Authorization: authorization },
    }),
  );
  return (await jsonOf<{ rooms: RoomSummary[] }>(res)).rooms;
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
    expect(await harness.inside(roomKey, ({ host }) => host.room())).toBeNull();
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
    const res = await harness.fetchWith(
      new Request(`${ROOMS}/${'c'.repeat(32)}`, { method: 'DELETE', headers: { Origin: ORIGIN } }),
      { DISCORD_CLIENT_ID: undefined, DISCORD_CLIENT_SECRET: undefined, SESSION_SECRET: undefined },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'login-unavailable' });
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

  it('finds by its key a room the GM may delete, marked so, and nothing for a key it lacks or cannot be', async () => {
    const roomKey = await createRoom({}, 'finder-gm');
    const find = (key: string, userId?: string) =>
      harness.fetch(
        new Request(`${ROOMS}/${key}`, {
          headers: {
            Origin: ORIGIN,
            'CF-Connecting-IP': freshIp(),
            ...(userId ? { Authorization: `Bearer ${accessTokenFor(userId)}` } : {}),
          },
        }),
      );

    expect(
      (await jsonOf<{ room: RoomSummary }>(await find(roomKey, 'user-finder-gm'))).room.deletable,
    ).toBe(true);
    expect((await jsonOf<{ room: RoomSummary }>(await find(roomKey))).room).not.toHaveProperty(
      'deletable',
    );
    const missing = await find('0'.repeat(32));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'room-not-found' });
    expect((await find('not-a-key')).status).toBe(400);
  });

  it('stops one address that asks for the list too often', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await harness.fetch(
        new Request(ROOMS, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('counts finding one room by its key with the list', async () => {
    const roomKey = await createRoom({}, 'counted-gm');
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await harness.fetch(
        new Request(`${ROOMS}/${roomKey}`, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('lists the rooms of a Worker without login', async () => {
    const res = await harness.fetchWith(new Request(ROOMS, { headers: { Origin: ORIGIN } }), {
      DISCORD_CLIENT_ID: undefined,
      DISCORD_CLIENT_SECRET: undefined,
      SESSION_SECRET: undefined,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: expect.any(Array) });
  });

  it('finds a room by its key on a Worker without login, marked for nobody', async () => {
    const roomKey = await createRoom({}, 'loginless-gm');
    const res = await harness.fetchWith(
      new Request(`${ROOMS}/${roomKey}`, { headers: { Origin: ORIGIN } }),
      { DISCORD_CLIENT_ID: undefined, DISCORD_CLIENT_SECRET: undefined, SESSION_SECRET: undefined },
    );

    expect(res.status).toBe(200);
    expect((await jsonOf<{ room: RoomSummary }>(res)).room).not.toHaveProperty('deletable');
  });
});
