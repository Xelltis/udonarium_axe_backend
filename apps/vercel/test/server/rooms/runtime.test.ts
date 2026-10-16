import { encode } from '@msgpack/msgpack';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { PROTOCOL_VERSION } from '../../../contracts/protocol.js';
import type { ServerMessage } from '../../../contracts/protocol.js';
import { ACCESS_TOKEN_SECONDS, signToken } from '../../../src/core/auth/tokens.js';
import { decodeFrame } from '../../../src/core/rooms/codec.js';
import { vercelBackend } from '../../../src/server/backend.js';
import { RoomRuntime } from '../../../src/server/rooms/runtime.js';
import { useRedis } from '../redis-helpers.js';
import { LOGIN, depsOf } from '../server-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

/** 部屋のサーバーが受けた WebSocket の代わり */
class FakeWs extends EventEmitter {
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason ?? '')));
  }

  /** 届いたもののうち、部屋のメッセージ */
  messages(): ServerMessage[] {
    return this.sent.flatMap((data) =>
      typeof data === 'string' ? [] : [decodeFrame(data) as ServerMessage],
    );
  }

  hello(peerId: string): void {
    const userId = `user-${peerId}`;
    this.emit(
      'message',
      Buffer.from(
        encode({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          peerId,
          userId,
          accessToken: signToken<'access'>(
            { aud: 'access', sub: `discord:${peerId}`, uid: userId, name: peerId },
            ACCESS_TOKEN_SECONDS,
            LOGIN.SESSION_SECRET,
          ),
        }),
      ),
      true,
    );
  }
}

/** 部屋を作った部屋のサーバーと、別の設定の runtime */
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
    { socketSeconds: options.socketSeconds ?? 60, parkMs: options.parkMs },
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

    await vi.waitFor(() =>
      expect(ws.messages().map((message) => message.type)).toContain('welcome'),
    );
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
    void runtime.openRoom('room')?.then((room) => room.release());
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
