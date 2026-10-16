import { encode } from '@msgpack/msgpack';
import { gzipSync } from 'node:zlib';

import { CHAT_TAB_LIST_IDENTIFIER, PROTOCOL_VERSION } from '../../contracts/protocol.js';
import type { CreateRoomResponse, ServerMessage } from '../../contracts/protocol.js';
import { decodeFrame } from '../../src/core/rooms/codec.js';
import { harness } from '../harness.js';
import type { TestSocket } from './harness-api.js';
import { ORIGIN, OTHER_ROOM_KEY, ROOM_KEY, UPLOADER, accessTokenFor, freshIp, jsonOf } from './helpers.js';

export const ROOMS = 'https://backend.example/v1/rooms';

/** The person who made the rooms. They come into none of them, so everyone who comes in is a player. */
export const HOST = 'user-host';

/** Calls the API that makes a room. Unless told otherwise, HOST makes it, logged in. */
export const postRoom = (body: unknown, headers: Record<string, string> = {}) =>
  harness.fetch(
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
    })
  );

/** Makes a room and returns its key. Given a creator, the person with that peerId becomes the GM. */
export const createRoom = async (body: { name?: string; password?: string } = {}, creator?: string) => {
  const res = await postRoom(
    { name: 'test room', ...body },
    creator ? { Authorization: `Bearer ${accessTokenFor(`user-${creator}`)}` } : {}
  );
  if (res.status !== 201) throw new Error(`room not created: ${res.status}`);
  return (await jsonOf<CreateRoomResponse>(res)).roomKey;
};

export const listRooms = async () => {
  const res = await harness.fetch(new Request(ROOMS, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': freshIp() } }));
  return (await jsonOf<{ rooms: { roomKey: string; members: number; hasPassword: boolean }[] }>(res)).rooms;
};

/** A request that opens a WebSocket to a room. */
export const upgrade = (roomKey: string, headers: Record<string, string> = {}) =>
  harness.upgrade(
    new Request(`${ROOMS}/${roomKey}/ws`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN, 'CF-Connecting-IP': freshIp(), ...headers },
    })
  );

const WAIT_MS = 30_000;

/** A client connected to a room. Reads what arrives, in order. */
export class Client {
  /** The frames that have arrived and have not been read yet. */
  private readonly inbox: { raw: ArrayBuffer | string; message: ServerMessage | string }[] = [];
  private wake: (() => void) | null = null;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: TestSocket) {
    socket.onMessage((raw) => {
      const message = typeof raw === 'string' ? raw : (decodeFrame(raw) as ServerMessage);
      this.inbox.push({ raw, message });
      this.wake?.();
    });
    this.closed = new Promise((resolve) => {
      socket.onClose((code, reason) => resolve({ code, reason }));
    });
  }

  /** The next thing to arrive. Throws when nothing arrives. */
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

  /** The next message to arrive. Throws when it is of another type. */
  async next<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    const { message } = await this.nextRaw();
    if (typeof message === 'string' || message.type !== type) {
      throw new Error(`expected ${type} but got ${JSON.stringify(message)}`);
    }
    return message as Extract<ServerMessage, { type: T }>;
  }

  /** The events of the next data to arrive. */
  async events(): Promise<{ eventName: string; data: unknown; sendFrom: string }[]> {
    return (await this.next('data')).events;
  }

  /** Checks that nothing has arrived, by having a marker sent back to itself. */
  async expectQuiet(): Promise<void> {
    this.send({ type: 'time' });
    await this.next('time');
  }

  send(message: unknown, options: { gzip?: boolean } = {}): void {
    const bytes = encode(message);
    this.socket.send(options.gzip ? gzipSync(bytes) : bytes);
  }

  /** Sends events. */
  emit(events: { eventName: string; data: unknown }[], to?: string): void {
    this.send({ type: 'send', ...(to === undefined ? {} : { to }), events });
  }

  /** Comes in. Usually logged in as `user-<peerId>`. With accessToken set to null, comes in as a guest. */
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
    this.socket.close(1000, 'bye');
  }
}

export const connect = async (roomKey: string): Promise<Client> => {
  const res = await upgrade(roomKey);
  if (!res.socket) throw new Error(`not upgraded: ${res.status}`);
  return new Client(res.socket);
};

/**
 * The reason given when a connection to a room is refused. When there is no room or it is full, the
 * connection is made and then refused.
 */
export const refusalOf = async (roomKey: string) => {
  const client = await connect(roomKey);
  const code = (await client.next('error')).code;
  await client.closed;
  return code;
};

/** Comes into a room. Returns once it has read welcome and the server catalog that follows. */
export const join = async (roomKey: string, peerId: string, extra: Record<string, unknown> = {}) => {
  const client = await connect(roomKey);
  client.hello(peerId, extra);
  const welcome = await client.next('welcome');
  const catalog = await client.events();
  return { client, welcome, catalog };
};

/** The connections that keep UPLOADER in a seat. One for each room key. */
const seatedUploaders = new Map<string, Client>();

/**
 * Has UPLOADER make the ROOM_KEY and OTHER_ROOM_KEY rooms when they are not there yet, and keeps it
 * seated in them. Storing an asset asks the room whether the person storing it has a seat there now as
 * a GM or player, so this is called before trying the asset routes.
 */
export const prepareAssetRooms = async () => {
  for (const roomKey of [ROOM_KEY, OTHER_ROOM_KEY]) {
    const allowed = await harness.canUpload(roomKey, UPLOADER);
    if (allowed === 'ok') continue;
    if (allowed === 'room-not-found') {
      await harness.createRoom({
        roomKey,
        roomId: 'abc',
        name: 'assets',
        password: '',
        creatorUserId: UPLOADER,
        host: 'backend.example',
      });
    }
    const client = await connect(roomKey);
    client.hello(UPLOADER, { userId: UPLOADER, accessToken: accessTokenFor(UPLOADER) });
    await client.next('welcome');
    seatedUploaders.set(roomKey, client);
  }
};

/** The contents of an object that is synced. */
export const contextOf = (
  identifier: string,
  majorVersion: number,
  minorVersion: number,
  syncData: Record<string, unknown> = { value: `${identifier}@${majorVersion}` },
  aliasName = 'character'
) => ({ aliasName, identifier, majorVersion, minorVersion, syncData });

/** Axe's list of chat tabs. Tabs go under it, and roll results can go only in the tabs right under it. */
export const chatTabList = () => contextOf(CHAT_TAB_LIST_IDENTIFIER, 1, 0.5, { attributes: {} }, 'chat-tab-list');

/** A tab right under the tab list. */
export const listedTabOf = (identifier: string, attributes: Record<string, unknown> = {}) =>
  contextOf(
    identifier,
    1,
    0.5,
    { parentIdentifier: CHAT_TAB_LIST_IDENTIFIER, attributes: { name: identifier, ...attributes } },
    'chat-tab'
  );

/** Waits until the condition holds. News for the room list arrives after the response. */
export const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean) => {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (accept(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
