import { encode } from '@msgpack/msgpack';
import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { gzipSync } from 'node:zlib';

import { PROTOCOL_VERSION } from '../contracts/protocol';
import type { CreateRoomResponse, ServerMessage } from '../contracts/protocol';
import { decodeFrame } from '../src/rooms/codec';
import { ORIGIN, accessTokenFor, freshIp } from './helpers';

export const ROOMS = 'https://backend.example/v1/rooms';

/** 部屋を作った人。どの部屋にも入らないので、入る人はみな PL になる */
export const HOST = 'user-host';

/** 部屋を作る API を呼ぶ。指定しなければ HOST がログインして作る */
export const postRoom = (body: unknown, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request(ROOMS, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': freshIp(),
        Authorization: `Bearer ${accessTokenFor(HOST)}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

/** 部屋を作り、その鍵を返す。creator を指定すれば、その peerId の人が GM になる */
export const createRoom = async (
  body: { name?: string; password?: string } = {},
  creator?: string,
) => {
  const res = await postRoom(
    { name: 'test room', ...body },
    creator ? { Authorization: `Bearer ${accessTokenFor(`user-${creator}`)}` } : {},
  );
  if (res.status !== 201) throw new Error(`room not created: ${res.status}`);
  return (await res.json<CreateRoomResponse>()).roomKey;
};

export const listRooms = async () => {
  const res = await exports.default.fetch(
    new Request(ROOMS, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp() } }),
  );
  return (await res.json<{ rooms: { roomKey: string; members: number; hasPassword: boolean }[] }>())
    .rooms;
};

export const stubOf = (roomKey: string) => env.ROOMS.getByName(roomKey);

/** 部屋への WebSocket を開く要求 */
export const upgrade = (roomKey: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(
    new Request(`${ROOMS}/${roomKey}/ws`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), ...headers },
    }),
  );

const WAIT_MS = 10_000;

/** 部屋につないだクライアント。届いたものを順に読む */
export class Client {
  /** 届いたフレームのうち、まだ読んでいないもの */
  private readonly inbox: { raw: ArrayBuffer | string; message: ServerMessage | string }[] = [];
  private wake: (() => void) | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    // 新しい互換日付では、バイナリは Blob で届くのが標準になった
    ws.binaryType = 'arraybuffer';
    ws.accept();
    ws.addEventListener('message', (event) => {
      const raw = event.data as ArrayBuffer | string;
      const message = typeof raw === 'string' ? raw : (decodeFrame(raw) as ServerMessage);
      this.inbox.push({ raw, message });
      this.wake?.();
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
    });
  }

  /** 次に届いたもの。届かなければ例外 */
  async nextRaw(): Promise<{ raw: ArrayBuffer | string; message: ServerMessage | string }> {
    const deadline = Date.now() + WAIT_MS;
    while (this.inbox.length === 0) {
      if (Date.now() > deadline) throw new Error('nothing arrived');
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 50);
      });
    }
    return this.inbox.shift() as { raw: ArrayBuffer | string; message: ServerMessage | string };
  }

  /** 次に届いたメッセージ。種類が違えば例外 */
  async next<T extends ServerMessage['type']>(
    type: T,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const { message } = await this.nextRaw();
    if (typeof message === 'string' || message.type !== type) {
      throw new Error(`expected ${type} but got ${JSON.stringify(message)}`);
    }
    return message as Extract<ServerMessage, { type: T }>;
  }

  /** 次に届いた data のイベント */
  async events(): Promise<{ eventName: string; data: unknown; sendFrom: string }[]> {
    return (await this.next('data')).events;
  }

  /** 何も届いていないことを、印を自分宛てに折り返してもらって確かめる */
  async expectQuiet(): Promise<void> {
    this.send({ type: 'time' });
    await this.next('time');
  }

  send(message: unknown, options: { gzip?: boolean } = {}): void {
    const bytes = encode(message);
    this.ws.send(options.gzip ? gzipSync(bytes) : bytes);
  }

  /** イベントを送る */
  emit(events: { eventName: string; data: unknown }[], to?: string): void {
    this.send({ type: 'send', ...(to === undefined ? {} : { to }), events });
  }

  /** 入る。ふだんは `user-<peerId>` としてログインしている。accessToken を null にすれば見学で入る */
  hello(peerId: string, extra: Record<string, unknown> = {}): void {
    this.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      peerId,
      userId: `user-${peerId}`,
      accessToken: accessTokenFor(`user-${peerId}`),
      ...extra,
    });
  }

  close(): void {
    this.ws.close(1000, 'bye');
  }
}

export const connect = async (roomKey: string): Promise<Client> => {
  const res = await upgrade(roomKey);
  if (!res.webSocket) throw new Error(`not upgraded: ${res.status}`);
  return new Client(res.webSocket);
};

/** 部屋に入る。welcome と、続くサーバーのカタログまで読んだところで返す */
export const join = async (
  roomKey: string,
  peerId: string,
  extra: Record<string, unknown> = {},
) => {
  const client = await connect(roomKey);
  client.hello(peerId, extra);
  const welcome = await client.next('welcome');
  const catalog = await client.events();
  return { client, welcome, catalog };
};

/** 同期するオブジェクトの中身 */
export const contextOf = (
  identifier: string,
  majorVersion: number,
  minorVersion: number,
  syncData: Record<string, unknown> = { value: `${identifier}@${majorVersion}` },
  aliasName = 'character',
) => ({ aliasName, identifier, majorVersion, minorVersion, syncData });

/** 条件が満たされるまで待つ。部屋の一覧への知らせは、応答のあとに届く */
export const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean) => {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
