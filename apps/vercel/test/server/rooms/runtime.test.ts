import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { vercelBackend } from '../../../src/server/backend.js';
import { RoomRuntime } from '../../../src/server/rooms/runtime.js';
import { useRedis } from '../redis-helpers.js';
import { depsOf } from '../server-helpers.js';
import { FakeWs } from './fake-ws.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

/** A room server that made a room, and a runtime with other settings. */
const setUp = async (options: { socketSeconds?: number; parkMs?: number } = {}) => {
  const deps = await depsOf(connection.redis);
  await vercelBackend(deps).rooms.create({
    roomKey: 'room',
    roomId: 'abc',
    name: 'room',
    password: '',
    creatorUserId: 'user-gm',
    host: 'h',
  });
  const runtime = new RoomRuntime(
    (deps.runtime as unknown as { deps: ConstructorParameters<typeof RoomRuntime>[0] }).deps,
    { socketSeconds: options.socketSeconds ?? 60, parkMs: options.parkMs }
  );
  return { deps, runtime };
};

const attach = (runtime: RoomRuntime) => {
  const ws = new FakeWs();
  runtime.attach(ws as unknown as WebSocket, 'room');
  return ws;
};

describe('the room runtime', () => {
  it('answers ping itself, and hands what else comes, early or not, to the room', async () => {
    const { runtime } = await setUp();
    const ws = attach(runtime);
    ws.hello('alice');
    ws.emit('message', Buffer.from('ping'), false);

    await vi.waitFor(() => expect(ws.messages().map((message) => message.type)).toContain('welcome'));
    expect(ws.sent).toContain('pong');

    ws.emit('message', Buffer.from('hello?'), false);
    expect(ws.messages().at(-1)).toMatchObject({ type: 'error', code: 'bad-message' });
  });

  it('closes a socket itself before the time limit, and keeps its seat a while', async () => {
    const { runtime } = await setUp({ socketSeconds: 0.05, parkMs: 50 });
    const ws = attach(runtime);
    ws.hello('alice');
    await vi.waitFor(() => expect(ws.messages().length).toBeGreaterThan(0));
    const room = await runtime.openRoom('room');

    await vi.waitFor(() => expect(ws.closedWith).toEqual({ code: 1012, reason: 'rotate' }));
    expect(room?.size).toBe(1);
    await vi.waitFor(() => expect(room?.size).toBe(0));
    expect(room?.isReleased).toBe(true);
  });

  it('lets the room go when the socket went before the room was open', async () => {
    const { runtime } = await setUp();
    const ws = attach(runtime);
    ws.emit('close', 1000, Buffer.from(''));

    const room = await runtime.room('room');
    await vi.waitFor(() => expect(room.isReleased || room.size === 0).toBe(true));
  });

  it('says what goes wrong on a socket', async () => {
    const { runtime } = await setUp();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ws = attach(runtime);

    ws.emit('error', new Error('reset'));

    expect(error).toHaveBeenCalledWith('Room socket error:', expect.any(Error));
    ws.close(1000, 'bye');
  });

  it('closes a socket whose room could not be opened, and tries again for the next', async () => {
    const { runtime } = await setUp();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(connection.redis, 'hGetAll').mockRejectedValueOnce(new Error('down'));

    const ws = attach(runtime);

    await vi.waitFor(() => expect(ws.closedWith).toEqual({ code: 1011, reason: 'unavailable' }));
    expect(error).toHaveBeenCalledWith('Could not open the room:', expect.any(Error));
    vi.restoreAllMocks();
    const room = await runtime.room('room');
    expect(room.isReleased).toBe(false);
    await room.release();
  });

  it('opens a room again when it was let go while being waited for', async () => {
    const { runtime } = await setUp();
    const first = runtime.room('room');
    // Lets go after the first one gets the room and before the second one does.
    const { rooms } = runtime as unknown as {
      rooms: Map<string, Promise<{ room: { release(): Promise<void> } }>>;
    };
    void rooms.get('room')?.then(({ room }) => room.release());
    const second = runtime.room('room');

    const [one, two] = await Promise.all([first, second]);

    expect(one).not.toBe(two);
    expect(two.isReleased).toBe(false);
    await two.release();
  });

  it('keeps a newer opening of a room when an older one lets go late', async () => {
    const { runtime } = await setUp();
    const older = await runtime.room('room');
    await older.release();
    const newer = await runtime.room('room');

    older.onRelease();

    expect(await runtime.openRoom('room')).toBe(newer);
    await newer.release();
  });

  it('has nothing to let go on closing for a room another instance holds', async () => {
    const { runtime } = await setUp();
    const { rooms } = runtime as unknown as { rooms: Map<string, Promise<unknown>> };
    rooms.set('room', Promise.resolve({ holder: 'there' }));

    await runtime.close();

    expect(await runtime.openRoom('room')).toBeNull();
  });

  it('closes back with the code it was closed with when it may, and with 1000 when not', async () => {
    const { runtime } = await setUp();
    const codes: (number | undefined)[] = [];
    for (const code of [4000, 1001, undefined]) {
      const ws = attach(runtime);
      ws.close(code, 'x');
      codes.push(ws.closedWith?.code);
    }
    expect(codes).toEqual([4000, 1000, 1000]);
  });
});
