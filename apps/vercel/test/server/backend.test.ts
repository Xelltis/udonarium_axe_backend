import { describe, expect, it, vi } from 'vitest';

import { decodeFrame } from '../../src/core/rooms/codec.js';
import { storelessBackend, vercelBackend } from '../../src/server/backend.js';
import type { Upgrades } from '../../src/server/backend.js';
import { expiryKeyOf, roomKeysOf } from '../../src/server/rooms/keys.js';
import { FakeWs } from './rooms/fake-ws.js';
import { useRedis } from './redis-helpers.js';
import { depsOf } from './server-helpers.js';

const connection = useRedis();

const init = (roomKey: string) => ({
  roomKey,
  roomId: 'abc',
  name: 'room',
  password: '',
  creatorUserId: 'user-gm',
  host: 'backend.example',
});

const upgradeRequest = () => new Request('https://backend.example/v1/rooms/r/ws');

/** Acts as if the connection switched to a WebSocket. Remembers what was sent and how it closed. */
const fakeUpgrade = (upgrades: Upgrades, request: Request) => {
  const socket = {
    sent: [] as unknown[],
    closed: null as unknown,
    send(data: unknown) {
      this.sent.push(data);
    },
    close(code: number, reason: string) {
      this.closed = { code, reason };
    },
  };
  upgrades.set(request, (onSocket) => onSocket(socket as never));
  return socket;
};

describe('the Vercel backend', () => {
  it('answers whether a user may upload from the seats its holder wrote, while the room is held elsewhere', async () => {
    const deps = await depsOf(connection.redis);
    const backend = vercelBackend(deps);
    await backend.rooms.create(init('held'));
    const seats = roomKeysOf(deps.key, 'held').seats;
    await connection.redis.hSet(seats, {
      a: JSON.stringify({ userId: 'user-pl', account: true, role: 'pl' }),
      b: JSON.stringify({ userId: 'user-guest', account: false, role: 'guest' }),
      c: JSON.stringify({ userId: 'user-gm', account: true, role: 'gm' }),
    });

    expect(await backend.rooms.canUpload('held', 'user-pl')).toBe('ok');
    expect(await backend.rooms.canUpload('held', 'user-gm')).toBe('ok');
    expect(await backend.rooms.canUpload('held', 'user-guest')).toBe('not-a-player');
    expect(await backend.rooms.canUpload('missing', 'user-pl')).toBe('room-not-found');
  });

  it('lists and finds no room past its retention, or already gone', async () => {
    const deps = await depsOf(connection.redis);
    const backend = vercelBackend(deps);
    await backend.rooms.create(init('old'));
    await backend.rooms.create(init('gone'));
    await backend.rooms.create(init('new'));
    await connection.redis.zAdd(expiryKeyOf(deps.key), { score: Date.now() - 1, value: 'old' });
    await connection.redis.zRem(expiryKeyOf(deps.key), 'gone');

    expect((await backend.lobby.list()).map((room) => room.roomKey)).toEqual(['new']);
    expect(await backend.lobby.find('old')).toBeNull();
    expect(await backend.lobby.find('gone')).toBeNull();
    expect(await backend.lobby.find('new')).toMatchObject({ roomKey: 'new' });
    expect(await backend.lobby.find('never')).toBeNull();
  });

  it('sweeps rooms past their time while listing, making and entering rooms', async () => {
    const deps = await depsOf(connection.redis);
    const soon = vi.spyOn(deps.sweeper, 'soon');
    const backend = vercelBackend(deps);
    const request = upgradeRequest();
    const ws = new FakeWs();
    deps.upgrades.set(request, (onSocket) => onSocket(ws as never));

    await backend.lobby.list();
    await backend.rooms.create(init('made'));
    await backend.rooms.connect(request, 'missing');

    expect(soon).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(ws.closedWith).toEqual({ code: 4000, reason: 'room-not-found' }));
  });

  it('asks for an upgrade before handing a room a socket', async () => {
    const backend = vercelBackend(await depsOf(connection.redis));
    const res = await backend.rooms.connect(upgradeRequest(), 'r');

    expect(res.status).toBe(426);
  });
});

describe('the backend without a store', () => {
  it('has no rooms, and tells a socket so before closing it', async () => {
    const upgrades: Upgrades = new WeakMap();
    const backend = storelessBackend(upgrades);
    const request = upgradeRequest();
    const socket = fakeUpgrade(upgrades, request);

    await backend.rooms.connect(request, 'r');

    expect(await backend.limit(request, 'read')).toBe(true);
    expect(await backend.lobby.list()).toEqual([]);
    expect(await backend.lobby.find('r')).toBeNull();
    expect(await backend.rooms.remove('r', 'u')).toBe('not-found');
    expect(await backend.rooms.canUpload('r', 'u')).toBe('room-not-found');
    expect((await backend.rooms.connect(upgradeRequest(), 'r')).status).toBe(426);
    expect(decodeFrame(socket.sent[0] as Uint8Array)).toMatchObject({ code: 'room-not-found' });
    expect(socket.closed).toEqual({ code: 4000, reason: 'room-not-found' });
  });

  it('cannot be asked for what needs a store', () => {
    const backend = storelessBackend(new WeakMap());
    const asks = [
      () => backend.rooms.create(init('r')),
      () => backend.account('discord:1'),
      ...Object.values(backend.assets).map((ask) => () => (ask as () => unknown)()),
    ];
    for (const ask of asks) expect(ask).toThrow('There are no rooms without a store');
    expect(vi.isMockFunction(backend.limit)).toBe(false);
  });
});
