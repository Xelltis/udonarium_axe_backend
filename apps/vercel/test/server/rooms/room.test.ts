import { encode } from '@msgpack/msgpack';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '../../../contracts/protocol.js';
import { ACCESS_TOKEN_SECONDS, signToken } from '../../../src/core/auth/tokens.js';
import { BanList } from '../../../src/core/moderation/bans.js';
import { redisLobby } from '../../../src/server/lobby.js';
import { createRoom, expiryKeyOf, roomKeysOf } from '../../../src/server/rooms/keys.js';
import { VercelRoom } from '../../../src/server/rooms/room.js';
import type { Conn, RoomDeps } from '../../../src/server/rooms/room.js';
import type { Redis } from '../../../src/server/redis.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = 'room-test-secret-0123456789abcdefghij';

/** Makes a room, and returns what is needed to open it. */
const roomDepsOf = async (redis: Redis, overrides: Partial<RoomDeps> = {}) => {
  const key = freshKey();
  const lobby = redisLobby(redis, key);
  await createRoom(
    redis,
    key,
    {
      roomKey: 'room',
      roomId: 'abc',
      name: 'room',
      password: '',
      creatorUserId: 'user-gm',
      host: 'h',
    },
    3600
  );
  await lobby.register({
    roomKey: 'room',
    roomId: 'abc',
    name: 'room',
    hasPassword: false,
    members: 0,
  });
  const deps: RoomDeps = {
    redis,
    key,
    lobby,
    instance: 'here',
    retentionSeconds: 3600,
    sessionSecret: () => SECRET,
    assetUpload: null,
    deleteAssets: async () => undefined,
    readBans: async () => new BanList([]),
    defer: () => undefined,
    // Long enough not to fail to be extended even on a busy machine. The tests that wait for the
    // lease to run out take the lease away from outside.
    timing: { leaseMs: 1000, renewMs: 40, tickMs: 40 },
    ...overrides,
  };
  return { deps, key, lobby };
};

/** Someone connected to the room. Remembers what was sent to them and how they were closed. */
const connOf = (id: string): Conn & { closedWith: { code: number; reason: string } | null } => {
  const conn = {
    id,
    seat: null,
    closedWith: null as { code: number; reason: string } | null,
    socket: {
      send: () => undefined,
      close: (code: number, reason: string) => {
        conn.closedWith = { code, reason };
      },
    },
  };
  return conn;
};

/** Joins the room, once the bans have been read for the hello. */
const seat = async (room: VercelRoom, peerId: string) => {
  const conn = connOf(peerId);
  room.accept(conn);
  room.receive(
    conn,
    encode({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      peerId,
      userId: `user-${peerId}`,
      accessToken: signToken<'access'>(
        { aud: 'access', sub: `discord:${peerId}`, uid: `user-${peerId}`, name: peerId },
        ACCESS_TOKEN_SECONDS,
        SECRET
      ),
    })
  );
  await vi.waitFor(() => expect(conn.seat).not.toBeNull());
  return conn;
};

describe('a room held on Vercel', () => {
  it('waits for the lease another instance holds, and takes the room once it is free', async () => {
    const { deps, key } = await roomDepsOf(connection.redis);
    await connection.redis.set(roomKeysOf(key, 'room').lease, 'there:1', { PX: 150 });
    const started = Date.now();

    const room = await VercelRoom.open(deps, 'room');

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(await connection.redis.get(roomKeysOf(key, 'room').lease)).toMatch(/^here:/);
    await room.release();
    expect(await connection.redis.get(roomKeysOf(key, 'room').lease)).toBeNull();
  });

  it('waits for a live instance holding the room to let it go, to open the room itself', async () => {
    const { deps, key } = await roomDepsOf(connection.redis, {
      isAlive: () => Promise.resolve(true),
    });
    await connection.redis.set(roomKeysOf(key, 'room').lease, 'there:1', { PX: 150 });

    const room = await VercelRoom.open(deps, 'room');

    expect(await connection.redis.get(roomKeysOf(key, 'room').lease)).toMatch(/^here:/);
    await room.release();
  });

  it('keeps its lease for as long as it holds the room', async () => {
    const { deps, key } = await roomDepsOf(connection.redis, {
      timing: { leaseMs: 60_000, renewMs: 40, tickMs: 40 },
    });
    const room = await VercelRoom.open(deps, 'room');
    const lease = roomKeysOf(key, 'room').lease;
    await connection.redis.pExpire(lease, 5_000);

    await vi.waitFor(async () => expect(await connection.redis.pTTL(lease)).toBeGreaterThan(5_000), {
      timeout: 4_000,
    });

    expect(room.isReleased).toBe(false);
    expect(await connection.redis.get(lease)).toMatch(/^here:/);
    await room.release();
  });

  it('gives the room up once its lease is gone, even with nobody writing', async () => {
    const { deps, key } = await roomDepsOf(connection.redis);
    const room = await VercelRoom.open(deps, 'room');

    await connection.redis.set(roomKeysOf(key, 'room').lease, 'there:3');

    await vi.waitFor(() => expect(room.isReleased).toBe(true));
  });

  it('gives the room up when a write of its objects finds the lease gone', async () => {
    const { deps, key } = await roomDepsOf(connection.redis, {
      timing: { leaseMs: 60_000, renewMs: 60_000, tickMs: 60_000 },
    });
    const room = await VercelRoom.open(deps, 'room');
    await connection.redis.set(roomKeysOf(key, 'room').lease, 'there:4');

    room.store().put(
      {
        aliasName: 'character',
        identifier: 'piece',
        majorVersion: 1,
        minorVersion: 0.5,
        syncData: {},
      },
      null
    );
    room.store().flush();

    await vi.waitFor(() => expect(room.isReleased).toBe(true));
  });

  it('gives the room up when another takes its lease, asking its sockets to come back', async () => {
    const { deps, key } = await roomDepsOf(connection.redis);
    const room = await VercelRoom.open(deps, 'room');
    const alice = await seat(room, 'alice');

    await connection.redis.set(roomKeysOf(key, 'room').lease, 'there:2');
    await vi.waitFor(() => expect(room.isReleased).toBe(true));

    expect(alice.closedWith).toEqual({ code: 1012, reason: 'moved' });
    room.stepDown();
  });

  it('says so when it could not renew its lease', async () => {
    const { deps } = await roomDepsOf(connection.redis);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const room = await VercelRoom.open(deps, 'room');
    const evaluate = connection.redis.eval.bind(connection.redis);
    vi.spyOn(connection.redis, 'eval').mockImplementation(((script: string, options: never) =>
      script.includes('PEXPIRE') ? Promise.reject(new Error('down')) : evaluate(script, options)) as never);

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Could not keep the room’s lease:', expect.any(Error)));
    vi.restoreAllMocks();
    await room.release();
  });

  it('keeps putting off deleting the room while people are in', async () => {
    const { deps, key } = await roomDepsOf(connection.redis);
    const room = await VercelRoom.open(deps, 'room');
    const deleteAt = () => connection.redis.zScore(expiryKeyOf(key), 'room');
    const created = await deleteAt();

    await seat(room, 'alice');

    await vi.waitFor(async () => expect(await deleteAt()).toBeGreaterThan(created as number));
    const occupied = await deleteAt();
    await vi.waitFor(async () => expect(await deleteAt()).toBeGreaterThan(occupied as number));
    await room.release();
  });

  it('says so when it could not keep the room, or put it right in the lobby', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, lobby } = await roomDepsOf(connection.redis);
    const room = await VercelRoom.open(deps, 'room');
    vi.spyOn(connection.redis, 'eval').mockRejectedValue(new Error('down'));
    vi.spyOn(lobby, 'setMembers').mockRejectedValue(new Error('down'));

    room.occupied();
    room.lobbyChanged('room');
    await room.settle();

    expect(error).toHaveBeenCalledWith('Could not keep the room:', expect.any(Error));
    expect(error).toHaveBeenCalledWith('Lobby update failed:', expect.any(Error));
    vi.restoreAllMocks();
    await room.release();
  });

  it('looks around while people are in, and no longer once it has let go', async () => {
    const { deps, lobby } = await roomDepsOf(connection.redis);
    const room = await VercelRoom.open(deps, 'room');
    await seat(room, 'alice');

    await vi.waitFor(async () => expect((await lobby.find('room'))?.members).toBe(1));
    await room.release();
    room.tick();
  });

  it('says so when it cannot tell whether another instance is still there', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = await roomDepsOf(connection.redis, {
      isAlive: () => Promise.reject(new Error('down')),
    });
    const room = await VercelRoom.open(deps, 'room');
    room.accept({ ...connOf('far'), instance: 'there' });

    room.tick();

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Could not look for lost instances:', expect.any(Error)));
    await room.release();
  });

  it('still deletes the room when its assets cannot be, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, key } = await roomDepsOf(connection.redis, {
      deleteAssets: () => Promise.reject(new Error('blob down')),
    });
    const room = await VercelRoom.open(deps, 'room');

    expect(await room.deleteRoom('user-gm')).toBe('deleted');

    expect(error).toHaveBeenCalledWith('Room asset deletion failed:', expect.any(Error));
    expect(await connection.redis.exists(roomKeysOf(key, 'room').meta)).toBe(0);
  });

  it('leaves a room it could not finish deleting to be tried again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps, lobby, key } = await roomDepsOf(connection.redis);
    vi.spyOn(lobby, 'remove').mockRejectedValue(new Error('lobby down'));
    const room = await VercelRoom.open(deps, 'room');

    await room.deleteRoom('user-gm');

    expect(error).toHaveBeenCalledWith('Room deletion failed, to be tried again:', expect.any(Error));
    expect(await connection.redis.hGet(roomKeysOf(key, 'room').meta, 'deleting')).toBe('1');
  });

  it('lets the room go as work that goes on after the last call, once its last socket here closes', async () => {
    const deferred: Promise<unknown>[] = [];
    const { deps, key } = await roomDepsOf(connection.redis, { defer: (work) => void deferred.push(work) });
    const room = await VercelRoom.open(deps, 'room');
    const conn = await seat(room, 'alice');

    room.closed(conn);
    await Promise.all(deferred);

    expect(room.isReleased).toBe(true);
    expect(await connection.redis.get(roomKeysOf(key, 'room').lease)).toBeNull();
  });

  it('only turns people away for a room that is not there', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { deps } = await roomDepsOf(connection.redis);
    const room = await VercelRoom.open(deps, 'missing');
    const conn = connOf('late');

    room.accept(conn);
    room.record('join', 'pl', 1);
    room.tick();

    expect(conn.closedWith).toEqual({ code: 4000, reason: 'room-not-found' });
    expect(await room.deleteRoom('user-gm')).toBe('not-found');
    await room.deletedElsewhere();
    expect(info).not.toHaveBeenCalled();
    room.onRelease();
    await room.release();
  });
});
