import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { COME_BACK_CODE, SyncEvent } from '../../../contracts/protocol.js';
import { memoryBucket } from '../../../src/server/assets/bucket.js';
import { vercelBackend } from '../../../src/server/backend.js';
import { createServerDeps } from '../../../src/server/deps.js';
import { connectRedis } from '../../../src/server/redis.js';
import { roomKeysOf } from '../../../src/server/rooms/keys.js';
import { MAX_FRAMES_PER_WINDOW } from '../../../src/core/rooms/limits.js';
import { PART_BYTES } from '../../../src/server/rooms/relay.js';
import { VercelRoom } from '../../../src/server/rooms/room.js';
import { REDIS_URL } from '../redis-helpers.js';
import { configOf } from '../server-helpers.js';
import { FakeWs } from './fake-ws.js';

// When the WebSockets of one room land on different instances.

const opened: { runtime: { close(): Promise<void> }; redis: { destroy(): void } }[] = [];

afterEach(async () => {
  for (const deps of opened.splice(0)) {
    await deps.runtime.close();
    deps.redis.destroy();
  }
  vi.restoreAllMocks();
});

// No test waits for the lease to run out, so it is long enough not to fail to be extended even on a
// busy machine (the tests break when the owner changes). The check is made short.
const TIMING = { leaseMs: 5000, renewMs: 100, tickMs: 100 };

/**
 * Two instances that use the same Redis. Instance a makes the room. Instance b's WebSockets close
 * after socketSecondsOfB, and b looks for the owner for up to twice leaseMsOfB.
 */
const twoInstances = async ({
  parkMs = 50,
  socketSecondsOfB,
  leaseMsOfB = TIMING.leaseMs,
  deferOfA,
}: {
  parkMs?: number;
  socketSecondsOfB?: number;
  leaseMsOfB?: number;
  deferOfA?: (work: Promise<unknown>) => void;
} = {}) => {
  const config = configOf();
  const make = async (
    instance: string,
    roomSocketSeconds = config.roomSocketSeconds,
    leaseMs = TIMING.leaseMs,
    defer?: (work: Promise<unknown>) => void
  ) => {
    const redis = await connectRedis(REDIS_URL);
    const deps = await createServerDeps(
      { ...config, roomSocketSeconds },
      { bucketOf: () => memoryBucket(), instance, timing: { ...TIMING, leaseMs }, parkMs, defer },
      redis
    );
    opened.push(deps);
    return deps;
  };
  const a = await make('a', undefined, undefined, deferOfA);
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

/** Joins the room. */
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
    await vi.waitFor(() => expect(bob.sent).toContain('pong'));
  });

  it('lets nobody who left put assets in from an instance that does not hold the room', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'gm');
    const alice = await enter(a, 'alice');
    await vi.waitFor(async () => expect(await vercelBackend(b).rooms.canUpload('room', 'user-alice')).toBe('ok'));

    alice.close(1000, 'bye');

    await vi.waitFor(async () =>
      expect(await vercelBackend(b).rooms.canUpload('room', 'user-alice')).toBe('not-a-player')
    );
  });

  it('clears the seats an owner that went away left behind, on taking the room', async () => {
    const { b } = await twoInstances();
    const seats = roomKeysOf(b.key, 'room').seats;
    await b.redis.hSet(seats, 'gone-conn', JSON.stringify({ userId: 'user-ghost', account: true, role: 'pl' }));

    const room = await b.runtime.room('room');
    await room.settle();

    expect(await b.redis.hVals(seats)).toEqual([]);
  });

  it('has the instance holding the room answer a ping relayed to it', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    const publish = vi.spyOn(b.relay, 'publish');

    bob.emit('message', Buffer.from('ping'), false);

    await vi.waitFor(() => expect(bob.sent).toContain('pong'));
    expect(publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ t: 'frame', d: 'ping' }));
  });

  it('passes a relayed socket’s pings on no sooner than one in five seconds', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    const publish = vi.spyOn(b.relay, 'publish');

    bob.emit('message', Buffer.from('ping'), false);
    bob.emit('message', Buffer.from('ping'), false);

    await vi.waitFor(() => expect(bob.sent).toContain('pong'));
    const pings = publish.mock.calls.filter(([, message]) => message.t === 'frame' && message.d === 'ping');
    expect(pings).toHaveLength(1);
    expect(bob.sent.filter((data) => data === 'pong')).toHaveLength(1);
  });

  it('cuts off a relayed socket whose pings go past the limit on frames', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    const room = (await a.runtime.openRoom('room')) as VercelRoom;
    const [relayed] = room.remotes;
    const { rates } = room.engine as unknown as { rates: WeakMap<object, { count: number }> };
    (rates.get(relayed) as { count: number }).count = MAX_FRAMES_PER_WINDOW;

    bob.emit('message', Buffer.from('ping'), false);

    await vi.waitFor(() =>
      expect(bob.messages()).toContainEqual(expect.objectContaining({ type: 'error', code: 'too-many-messages' }))
    );
    expect(bob.sent).not.toContain('pong');
    expect(room.takeRelayedPing(relayed)).toBe(false);
  });

  it('asks a socket to come back at its ping once the instance holding the room is gone', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    await a.relay.stop();

    bob.emit('message', Buffer.from('ping'), false);

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: COME_BACK_CODE, reason: 'moved' }));
    expect(bob.sent).not.toContain('pong');
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

  it('carries what the holder sends a socket elsewhere in order, a frame in parts before the next', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    // Random, so that it does not shrink on its way, as one picture's worth of data would not.
    const scene = randomBytes(PART_BYTES * 2).toString('base64');
    // A frame in parts takes longer on its way, as over a network.
    const publish = a.relay.publish.bind(a.relay);
    vi.spyOn(a.relay, 'publish').mockImplementation(async (channel, message) => {
      if (message.t === 'frame' && message.d.length > PART_BYTES) await new Promise((wait) => setTimeout(wait, 50));
      return publish(channel, message);
    });

    alice.emitMessage({ type: 'send', events: [update('scene', 1, { scene }), update('after', 1)] });
    alice.emitMessage({ type: 'send', events: [update('last', 1)] });

    const order = () =>
      bob
        .events()
        .map((event) => (event.data as { identifier?: string }).identifier)
        .filter((identifier) => identifier === 'scene' || identifier === 'after' || identifier === 'last');
    await vi.waitFor(() => expect(order()).toHaveLength(3));
    expect(order()).toEqual(['scene', 'after', 'last']);
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

  it('goes on asking the sockets elsewhere back after the last call, as letting the room go does', async () => {
    const deferred: Promise<unknown>[] = [];
    const { a, b } = await twoInstances({ deferOfA: (work) => deferred.push(work) });
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const publish = a.relay.publish.bind(a.relay);
    const published = vi.spyOn(a.relay, 'publish').mockImplementation(async (channel, message) => {
      if (channel === a.relay.controlOf('room')) await held;
      return publish(channel, message);
    });

    alice.close(1000, 'bye');
    await vi.waitFor(() => expect(published).toHaveBeenCalledWith(a.relay.controlOf('room'), { t: 'moved' }));
    let settled = false;
    void Promise.all(deferred).then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    letGo();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(bob.closedWith).toEqual({ code: 1012, reason: 'moved' });
  });

  it('says so when it cannot ask the sockets elsewhere back on letting the room go', async () => {
    const { a, b } = await twoInstances();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const alice = await enter(a, 'alice');
    await enter(b, 'bob');
    const publish = a.relay.publish.bind(a.relay);
    vi.spyOn(a.relay, 'publish').mockImplementation((channel, message) =>
      channel === a.relay.controlOf('room') ? Promise.reject(new Error('blip')) : publish(channel, message)
    );

    alice.close(1000, 'bye');

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('Could not ask the room’s sockets on other instances back:', expect.any(Error))
    );
  });

  it('says so when it cannot delete the room another instance asked it to', async () => {
    const { a, b } = await twoInstances();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await enter(a, 'alice');
    await enter(b, 'bob');
    vi.spyOn(VercelRoom.prototype, 'deletedElsewhere').mockRejectedValue(new Error('down'));

    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('deleted');

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith('Could not delete the room asked for:', expect.any(Error))
    );
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
    // Stops only the listeners of a. Instance a still holds the lease, so b keeps trying to send to it.
    await a.relay.unsubscribe(a.relay.inboundOf('room'));
    await a.relay.unsubscribe(a.relay.ownerControlOf('room'));

    bob.emitMessage({ type: 'time' });
    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('deleted');

    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'moved' }));
    expect(await b.redis.hGet(roomKeysOf(b.key, 'room').meta, 'deleting')).toBe('1');
    alice.close(1000, 'bye');
  });

  it('marks a room for deleting when its holder is gone, though a socket is still relayed there', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    await enter(b, 'bob');
    await a.relay.unsubscribe(a.relay.inboundOf('room'));
    await a.relay.unsubscribe(a.relay.ownerControlOf('room'));

    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('deleted');

    expect(await b.redis.hGet(roomKeysOf(b.key, 'room').meta, 'deleting')).toBe('1');
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
    // Waits until the seat kept aside is let go.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const seen = alice.messages().map((message) => message.type);
    expect(seen.filter((type) => type === 'join')).toHaveLength(1);
    expect(seen).not.toContain('leave');
  });

  it('asks a socket elsewhere to come back only once what it sent has reached the room', async () => {
    const { a, b } = await twoInstances({ socketSecondsOfB: 2 });
    const alice = await enter(a, 'alice');
    const bob = await enter(b, 'bob');
    bob.emitMessage({ type: 'send', events: [update('piece', 1)] });
    const heard = (eventName: string) =>
      alice
        .events()
        .some(
          (event) => event.eventName === eventName && (event.data as { identifier?: string }).identifier === 'piece'
        );
    await vi.waitFor(() => expect(heard(SyncEvent.UPDATE)).toBe(true));
    const publish = b.relay.publish.bind(b.relay);
    vi.spyOn(b.relay, 'publish').mockImplementation(async (channel, message) => {
      if (message.t === 'frame') await new Promise((resolve) => setTimeout(resolve, 2500));
      return publish(channel, message);
    });

    bob.emitMessage({
      type: 'send',
      events: [{ eventName: SyncEvent.DELETE, data: { aliasName: 'character', identifier: 'piece' } }],
    });
    await vi.waitFor(() => expect(bob.closedWith).toEqual({ code: 1012, reason: 'rotate' }), { timeout: 6000 });
    await enter(a, 'bob');

    await vi.waitFor(() => expect(heard(SyncEvent.DELETE)).toBe(true), { timeout: 4000 });
  }, 15_000);

  it('stops hearing a room it let go while it was still setting the room up', async () => {
    const { a } = await twoInstances();
    const subscribe = vi.spyOn(a.relay, 'subscribe');
    const unsubscribe = vi.spyOn(a.relay, 'unsubscribe');
    const own = a.relay.ownerControlOf('room');
    const inbound = a.relay.inboundOf('room');
    const named = (spy: typeof subscribe | typeof unsubscribe, channel: string) =>
      spy.mock.calls.filter(([called]) => called === channel).length;

    attach(a).close(1000, 'bye');

    await vi.waitFor(() => expect([named(subscribe, own), named(unsubscribe, own)]).toEqual([1, 1]));
    await Promise.all([...subscribe.mock.results, ...unsubscribe.mock.results].map((result) => result.value));
    expect(await a.redis.pubSubNumSub([inbound, own])).toEqual({ [inbound]: 0, [own]: 0 });
  });

  it('claims afresh a room let go while a second socket waited for it, rather than seat that one alone', async () => {
    const { a, b } = await twoInstances();
    const first = attach(a);
    const alice = attach(a);

    first.close(1000, 'bye');
    alice.hello('alice');
    await welcomed(alice);
    await enter(b, 'bob');

    await vi.waitFor(() =>
      expect(alice.messages().some((message) => message.type === 'join' && message.member.peerId === 'bob')).toBe(true)
    );
  });

  it('asks a socket elsewhere to come back when it reaches a room let go but still heard', async () => {
    const { a } = await twoInstances();
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const unsubscribe = a.relay.unsubscribe.bind(a.relay);
    vi.spyOn(a.relay, 'unsubscribe').mockImplementation(async (channel) => {
      await held;
      return unsubscribe(channel);
    });
    const alice = await enter(a, 'alice');
    alice.close(1000, 'bye');
    await vi.waitFor(async () => expect(await a.redis.get(roomKeysOf(a.key, 'room').lease)).toBeNull());
    const told: unknown[] = [];
    await a.relay.subscribe(a.relay.outboundOf('b'), (message) => told.push(message));
    const publish = a.relay.publish.bind(a.relay);
    let failOnce = true;
    vi.spyOn(a.relay, 'publish').mockImplementation(async (channel, message) => {
      if (channel === a.relay.outboundOf('b') && failOnce) {
        failOnce = false;
        throw new Error('down');
      }
      return publish(channel, message);
    });

    await publish(a.relay.inboundOf('room'), { t: 'open', c: 'lost', i: 'b' });
    await publish(a.relay.inboundOf('room'), { t: 'frame', c: 'lost', d: 'hello' });
    await publish(a.relay.inboundOf('room'), { t: 'open', c: 'late', i: 'b' });

    await vi.waitFor(() => expect(told).toContainEqual({ t: 'close', c: 'late', code: 1012, reason: 'moved' }));
    letGo();
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

  it('takes a room’s sockets again once listening to the relay failed at first', async () => {
    const { a } = await twoInstances();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const subscribe = a.relay.subscribe.bind(a.relay);
    vi.spyOn(a.relay, 'subscribe')
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementation(subscribe);

    const first = attach(a);
    await vi.waitFor(() => expect(first.closedWith).toEqual({ code: 1011, reason: 'unavailable' }));

    await enter(a, 'alice');
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
    // What comes from b arrives in order, so once bob is in, what came before has been taken too.
    await enter(b, 'bob');

    expect(alice.closedWith).toBeNull();
    expect(alice.messages().filter((message) => message.type === 'error')).toEqual([]);
  });

  it('takes no more sockets from elsewhere for a room it has let go', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const room = (await a.runtime.openRoom('room')) as VercelRoom;
    // Keeps listening even after the room is let go.
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

  it('closes the seats a ban covers, on the instance that holds the room or by asking it', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const bob = new FakeWs();
    b.runtime.attach(bob as unknown as WebSocket, 'room', '192.0.2.7');
    bob.hello('bob');
    await welcomed(bob);
    const banOf = (kind: 'ip' | 'discord', value: string) => ({
      kind,
      value,
      reason: '',
      createdAt: 0,
      expiresAt: null,
    });
    const refused = (ws: FakeWs) =>
      ws.messages().some((message) => message.type === 'error' && message.code === 'banned');

    await b.runtime.expel('room', banOf('ip', '192.0.2.0/24'));

    await vi.waitFor(() => expect(refused(bob)).toBe(true));
    await vi.waitFor(() => expect(left(alice, 'bob')).toBe(true));
    expect(refused(alice)).toBe(false);

    await a.runtime.expel('room', banOf('discord', 'alice'));

    expect(refused(alice)).toBe(true);
    // A room nobody holds has nobody in it to close.
    await b.runtime.expel('nobody-here', banOf('discord', 'alice'));
  });

  it('deletes the room for the operator from an instance that does not hold it, whoever is GM', async () => {
    const { a, b } = await twoInstances();
    const alice = await enter(a, 'alice');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    expect(await b.runtime.deleteRoom('room', null)).toBe('deleted');

    await vi.waitFor(() =>
      expect(alice.messages().some((message) => message.type === 'error' && message.code === 'room-deleted')).toBe(true)
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"delete","detail":"operator"'));
  });

  it('finds no room to delete from another instance when it went meanwhile', async () => {
    const { a, b } = await twoInstances();
    await enter(a, 'alice');
    // The room goes away after the owner is checked.
    const hGetAll = b.redis.hGetAll.bind(b.redis);
    vi.spyOn(b.redis, 'hGetAll')
      .mockImplementationOnce(hGetAll as never)
      .mockResolvedValueOnce({} as never);

    expect(await b.runtime.deleteRoom('room', 'user-gm')).toBe('not-found');
  });
});
