import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { SyncEvent } from '../../../contracts/protocol.js';
import { memoryBucket } from '../../../src/server/assets/bucket.js';
import { vercelBackend } from '../../../src/server/backend.js';
import { createServerDeps } from '../../../src/server/deps.js';
import { connectRedis } from '../../../src/server/redis.js';
import { roomKeysOf } from '../../../src/server/rooms/keys.js';
import { PART_BYTES } from '../../../src/server/rooms/relay.js';
import { VercelRoom } from '../../../src/server/rooms/room.js';
import { REDIS_URL } from '../redis-helpers.js';
import { configOf } from '../server-helpers.js';
import { FakeWs } from './fake-ws.js';

// 1つの部屋の WebSocket が、ちがうインスタンスに着いたとき

const opened: { runtime: { close(): Promise<void> }; redis: { destroy(): void } }[] = [];

afterEach(async () => {
  for (const deps of opened.splice(0)) {
    await deps.runtime.close();
    deps.redis.destroy();
  }
  vi.restoreAllMocks();
});

// lease が切れるのを待つテストは無いので、混んだマシンでも延ばしそこねない長さにする（持ち主が替わると
// テストが崩れる）。見回りは短くする
const TIMING = { leaseMs: 5000, renewMs: 100, tickMs: 100 };

/**
 * 同じ Redis を使う2つのインスタンス。部屋は a が作る。b の WebSocket は socketSecondsOfB で閉じ、b は
 * 持ち主を leaseMsOfB の2倍まで探す
 */
const twoInstances = async ({
  parkMs = 50,
  socketSecondsOfB,
  leaseMsOfB = TIMING.leaseMs,
}: { parkMs?: number; socketSecondsOfB?: number; leaseMsOfB?: number } = {}) => {
  const config = configOf();
  const make = async (instance: string, roomSocketSeconds = config.roomSocketSeconds, leaseMs = TIMING.leaseMs) => {
    const redis = await connectRedis(REDIS_URL);
    const deps = await createServerDeps(
      { ...config, roomSocketSeconds },
      { bucketOf: () => memoryBucket(), instance, timing: { ...TIMING, leaseMs }, parkMs },
      redis
    );
    opened.push(deps);
    return deps;
  };
  const a = await make('a');
  const b = await make('b', socketSecondsOfB, leaseMsOfB);
  await vercelBackend(a).rooms.create({
    roomKey: 'room',
    roomId: 'abc',
    name: 'room',
    password: '',
    creatorUserId: 'user-gm',
    host: 'h',
  });
  return { a, b };
};

const attach = (deps: { runtime: { attach(ws: WebSocket, roomKey: string): void } }) => {
  const ws = new FakeWs();
  deps.runtime.attach(ws as unknown as WebSocket, 'room');
  return ws;
};

const welcomed = (ws: FakeWs) =>
  vi.waitFor(() => expect(ws.messages().some((message) => message.type === 'welcome')).toBe(true));

/** 部屋に入る */
const enter = async (deps: Parameters<typeof attach>[0], peerId: string) => {
  const ws = attach(deps);
  ws.hello(peerId);
  await welcomed(ws);
  return ws;
};

const left = (ws: FakeWs, peerId: string) =>
  ws.messages().some((message) => message.type === 'leave' && message.peerId === peerId);

const update = (identifier: string, majorVersion: number, syncData: Record<string, unknown> = {}) => ({
  eventName: SyncEvent.UPDATE,
  data: { aliasName: 'character', identifier, majorVersion, minorVersion: 0.5, syncData },
});

describe('a room whose sockets reach different instances', () => {
  it('brings them into one room, through the instance that holds it, in the order each was sent', async () => {
    const { a, b } = await twoInstances();
    const alice = attach(a);
    alice.hello('alice');
    await welcomed(alice);
    const bob = attach(b);
    bob.hello('bob');
    await welcomed(bob);

    for (let version = 1; version <= 20; version++) {
      bob.emitMessage({ type: 'send', events: [update('piece', version)] });
    }

    await vi.waitFor(() => expect(alice.messages().some((message) => message.type === 'join')).toBe(true));
    const pieces = () =>
      alice
        .events()
        .filter((event) => (event.data as { identifier?: string }).identifier === 'piece')
        .map((event) => (event.data as { majorVersion: number }).majorVersion);
    await vi.waitFor(() => expect(pieces()).toHaveLength(20));
    expect(pieces()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    bob.emit('message', Buffer.from('ping'), false);
    expect(bob.sent).toContain('pong');
  });

  it('carries a frame larger than one message can', async () => {
    const { a, b } = await twoInstances();
    const alice = attach(a);
    alice.hello('alice');
    await welcomed(alice);
    const bob = attach(b);
    bob.hello('bob');
    await welcomed(bob);
    const scene = 'x'.repeat(PART_BYTES * 2 + 10);

    bob.emitMessage({ type: 'send', events: [update('scene', 1, { scene })] });

    await vi.waitFor(() =>
      expect(alice.events().some((event) => (event.data as { identifier?: string }).identifier === 'scene')).toBe(true)
    );
    const event = alice.events().find((item) => (item.data as { identifier?: string }).identifier === 'scene');
    expect((event?.data as { syncData: { scene: string } }).syncData.scene).toBe(scene);
  });

  it('asks the sockets elsewhere to come back once the holder lets go, and a new holder takes them', async () => {
    const { a, b } = await twoInstances();
    const alice = attach(a);
    alice.hello('alice');
    await welcomed(alice);
    const bob = attach(b);
    bob.hello('bob');
    await welcomed(bob);

    alice.close(1000, 'bye');

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'moved' }));
    const again = attach(b);
    again.hello('bob');
    await welcomed(again);
    expect(await b.runtime.openRoom('room')).not.toBeNull();
    again.close(1000, 'bye');
  });

  it('lets the seats of an instance that went away go', async () => {
    const { a, b } = await twoInstances();
    const alice = attach(a);
    alice.hello('alice');
    await welcomed(alice);
    const bob = attach(b);
    bob.hello('bob');
    await welcomed(bob);

    await b.relay.stop();

    await vi.waitFor(() => expect(alice.messages().some((message) => message.type === 'leave')).toBe(true));
    alice.close(1000, 'bye');
  });

  it('deletes the room from an instance that does not hold it, for its GM only', async () => {
    const { a, b } = await twoInstances();
    const alice = attach(a);
    alice.hello('alice');
    await welcomed(alice);
    const bob = attach(b);
    bob.hello('bob');
    await welcomed(bob);

    expect(await b.runtime.deleteRoom('room', 'user-alice')).toBe('not-game-master');
    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('deleted');

    for (const ws of [alice, bob]) {
      await vi.waitFor(() =>
        expect(ws.messages().some((message) => message.type === 'error' && message.code === 'room-deleted')).toBe(true)
      );
    }
    await vi.waitFor(async () => expect(await a.redis.exists(roomKeysOf(a.key, 'room').meta)).toBe(0));
    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('not-found');
  });

  it('marks a room for deleting when its holder is gone, and tells a socket to come back', async () => {
    const { a, b } = await twoInstances();
    const alice = attach(a);
    alice.hello('alice');
    await welcomed(alice);
    const bob = attach(b);
    bob.hello('bob');
    await welcomed(bob);
    // a の受け口だけを止める。lease はまだ持っているので、b は a に送り続けようとする
    await a.relay.unsubscribe(a.relay.inboundOf('room'));
    await a.relay.unsubscribe(a.relay.controlOf('room'));

    bob.emitMessage({ type: 'time' });
    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('deleted');

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'moved' }));
    expect(await b.redis.hGet(roomKeysOf(b.key, 'room').meta, 'deleting')).toBe('1');
    alice.close(1000, 'bye');
  });

  it('keeps hearing about the room while any socket it forwards there is open', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    const carol = await enter(b, 'carol');

    bob.close(1000, 'bye');
    await vi.waitFor(() => expect(left(alice, 'bob')).toBe(true));
    alice.close(1000, 'bye');

    await vi.waitFor(() => expect(carol.closedWith).toEqual({ code: 1012, reason: 'moved' }));
  });

  it('keeps the seat of a socket elsewhere that it asked to come back, for the same person', async () => {
    const { a, b } = await twoInstances({ parkMs: 300, socketSecondsOfB: 0.3 });
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'rotate' }));
    await enter(a, 'bob');
    // 取っておいた席を放すまで待つ
    await new Promise((resolve) => setTimeout(resolve, 400));

    const seen = alice.messages().map((message) => message.type);
    expect(seen.filter((type) => type === 'join')).toHaveLength(1);
    expect(seen).not.toContain('leave');
  });

  it('asks a socket to come back when the instance holding the room does not hear it', async () => {
    const { a, b } = await twoInstances({ leaseMsOfB: 400 });
    await enter(a, 'alice');
    await a.relay.unsubscribe(a.relay.inboundOf('room'));

    const bob = attach(b);

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'moved' }), {
      timeout: 6000,
    });
    expect(bob.messages()).toEqual([]);
  }, 10_000);

  it('opens the room itself once the instance holding it lets it go', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const claims = vi.spyOn(VercelRoom, 'claim');

    const opening = b.runtime.room('room');
    await vi.waitFor(() => expect(claims).toHaveBeenCalled());
    expect(await claims.mock.results[0]?.value).toEqual({ holder: 'a' });
    alice.close(1000, 'bye');

    const room = await opening;
    expect(room.isReleased).toBe(false);
    await room.release();
  });

  it('says so when it cannot hear the room’s sockets on other instances', async () => {
    const { a } = await twoInstances();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const subscribe = a.relay.subscribe.bind(a.relay);
    vi.spyOn(a.relay, 'subscribe').mockImplementation(((channel: string, listener: (message: unknown) => void) =>
      channel === a.relay.inboundOf('room')
        ? Promise.reject(new Error('down'))
        : subscribe(channel, listener)) as never);

    await enter(a, 'alice');

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('Could not hear the room’s sockets on other instances:', expect.any(Error))
    );
  });

  it('lets pass what comes for a socket it does not know, and what is not for it', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');

    await b.relay.publish(a.relay.inboundOf('room'), { t: 'frame', c: 'nobody', d: 'hello?' });
    await b.relay.publish(a.relay.controlOf('room'), { t: 'moved' });
    // b からのものは順に届くので、bob が入れたら、その前のものも受けている
    await enter(b, 'bob');

    expect(alice.closedWith).toBeNull();
    expect(alice.messages().filter((message) => message.type === 'error')).toEqual([]);
  });

  it('takes no more sockets from elsewhere for a room it has let go', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const room = (await a.runtime.openRoom('room')) as VercelRoom;
    // 放したあとも聞こえたままにする
    vi.spyOn(a.relay, 'unsubscribe').mockResolvedValue(undefined);
    const accept = vi.spyOn(room, 'accept');
    alice.close(1000, 'bye');
    await vi.waitFor(() => expect(room.isReleased).toBe(true));
    const released = vi.spyOn(room, 'isReleased', 'get');

    expect(await b.relay.publish(a.relay.inboundOf('room'), { t: 'open', c: 'late', i: 'b' })).toBe(1);

    await vi.waitFor(() => expect(released).toHaveBeenCalled());
    expect(accept).not.toHaveBeenCalled();
  });

  it('carries on when what it says cannot reach a socket elsewhere', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    const publish = vi.spyOn(a.relay, 'publish').mockRejectedValue(new Error('down'));

    alice.emitMessage({ type: 'send', events: [update('piece', 1)] });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(a.relay.outboundOf('b'), expect.anything()));
    vi.restoreAllMocks();
    alice.emitMessage({ type: 'send', events: [update('piece', 2)] });

    await vi.waitFor(() =>
      expect(bob.events().some((event) => (event.data as { majorVersion?: number }).majorVersion === 2)).toBe(true)
    );
  });

  it('asks a socket to come back when what it sends cannot be carried', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    vi.spyOn(b.relay, 'publish').mockRejectedValueOnce(new Error('down'));

    bob.emitMessage({ type: 'time' });

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'moved' }));
    await vi.waitFor(() => expect(left(alice, 'bob')).toBe(true));
  });

  it('lets a socket elsewhere go that went before it could be carried', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    const room = (await a.runtime.openRoom('room')) as VercelRoom;
    const closed = vi.spyOn(room, 'closed');

    attach(b).close(1000, 'bye');

    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    expect(room.size).toBe(1);
  });

  it('finds no room to delete from another instance when it went meanwhile', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    // 持ち主を確かめたあとで、部屋が無くなる
    const hGetAll = b.redis.hGetAll.bind(b.redis);
    vi.spyOn(b.redis, 'hGetAll')
      .mockImplementationOnce(hGetAll as never)
      .mockResolvedValueOnce({} as never);

    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('not-found');
  });
});
