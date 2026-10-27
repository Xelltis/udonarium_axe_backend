import { decode, encode } from '@msgpack/msgpack';
import { gunzipSync } from 'node:zlib';
import { describe, inject, it } from 'vitest';

import { AUTHORITY_PEER_ID, AuthorityEvent, PROTOCOL_VERSION, SyncEvent } from '../../contracts/protocol';
import type { ObjectContext } from '../../contracts/protocol';
import { ACCESS_TOKEN_SECONDS, signToken } from '../../src/core/auth/tokens';
import { SCALES, buildRoom } from '../rows/room-model';
import type { Scale } from '../rows/room-model';

// `npm run latency`: people in a room on `wrangler dev`, over real WebSockets, timing what they wait
// for. It is run before and after a change to the room server, to see that nothing got slower.

declare module 'vitest' {
  export interface ProvidedContext {
    latency: { baseUrl: string; secret: string; origin: string };
  }
}
declare const __LATENCY_SCALES__: string;
declare const __LATENCY_RUNS__: number;

const UPDATES = 200;
const UPDATE_EVERY_MS = 50;
const ROLLS = 20;
// One connection may ask for 20 rolls in 10 seconds.
const ROLL_EVERY_MS = 500;
/** A peer that has heard nothing for this long has had everything there was to hear. */
const QUIET_MS = 1000;
const LOAD_FRAME = 1000;
const REQUEST_FRAME = 2000;

interface Heard {
  at: number;
  eventName: string;
  data: unknown;
}

/** One person in the room, with what they heard and when. */
class Person {
  private readonly heard: Heard[] = [];
  private readonly replies: { type: string; at: number; message: Record<string, unknown> }[] = [];
  private waiters: (() => void)[] = [];
  lastHeardAt = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return;
      const at = performance.now();
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const message = decode(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes) as Record<
        string,
        unknown
      >;
      this.lastHeardAt = at;
      if (message.type === 'data') {
        for (const item of message.events as { eventName: string; data: unknown }[]) {
          this.heard.push({ at, eventName: item.eventName, data: item.data });
        }
      }
      this.replies.push({ type: String(message.type), at, message });
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  static async open(roomKey: string): Promise<Person> {
    const { baseUrl, origin } = inject('latency');
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/v1/rooms/${roomKey}/ws`, {
      headers: { Origin: origin },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('could not connect')));
    });
    return new Person(socket);
  }

  send(message: unknown): void {
    this.socket.send(encode(message));
  }

  emit(events: { eventName: string; data: unknown }[], to?: string): void {
    this.send({ type: 'send', ...(to === undefined ? {} : { to }), events });
  }

  async hello(peerId: string): Promise<void> {
    this.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      peerId,
      userId: `user-${peerId}`,
      accessToken: tokenFor(`user-${peerId}`),
    });
    await this.reply('welcome');
  }

  /** Waits until a reply of that type comes, and returns when it came. */
  async reply(type: string, timeoutMs = 120_000): Promise<{ at: number; message: Record<string, unknown> }> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const index = this.replies.findIndex((reply) => reply.type === type);
      if (index >= 0) return this.replies.splice(index, 1)[0];
      const refused = this.replies.find((reply) => reply.type === 'error');
      if (refused) throw new Error(`refused while waiting for ${type}: ${JSON.stringify(refused.message)}`);
      if (performance.now() > deadline) throw new Error(`no ${type} came`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /** The events heard so far that pass the test. */
  events(test: (heard: Heard) => boolean): Heard[] {
    return this.heard.filter(test);
  }

  /** Waits until nothing has been heard for QUIET_MS, and returns when the last thing was heard. */
  async quiet(): Promise<number> {
    while (performance.now() - this.lastHeardAt < QUIET_MS) await sleep(100);
    return this.lastHeardAt;
  }

  close(): void {
    this.socket.close(1000, 'bye');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tokenFor = (userId: string) =>
  signToken<'access'>(
    { aud: 'access', sub: `discord:${userId}`, uid: userId, name: userId },
    ACCESS_TOKEN_SECONDS,
    inject('latency').secret
  );

const createRoom = async (name: string, gm: string): Promise<string> => {
  const { baseUrl, origin } = inject('latency');
  const res = await fetch(`${baseUrl}/v1/rooms`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(`user-${gm}`)}` },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`room not created: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { roomKey: string }).roomKey;
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
};

const identifierOf = (data: unknown) => (data as { identifier?: string }).identifier;

interface RunResult {
  'load: all heard (ms)': number;
  'load: all taken (ms)': number;
  'move p50 (ms)': number;
  'move p99 (ms)': number;
  'move after 15 s idle (ms)': number;
  'roll p50 (ms)': number;
  'roll p99 (ms)': number;
  'join: all received (ms)': number;
}

const runOnce = async (scale: Scale, index: number): Promise<RunResult> => {
  const model = buildRoom(scale);
  const roomKey = await createRoom(`latency ${scale} ${index}`, 'gm');
  const [gm, mover, watcher] = await Promise.all([Person.open(roomKey), Person.open(roomKey), Person.open(roomKey)]);
  await gm.hello('gm');
  await mover.hello('mover');
  await watcher.hello('watcher');

  // The GM loads the room's data, as Axe sends a loaded zip.
  const loadStart = performance.now();
  for (let i = 0; i < model.objects.length; i += LOAD_FRAME) {
    gm.emit(model.objects.slice(i, i + LOAD_FRAME).map((data) => ({ eventName: SyncEvent.UPDATE, data })));
  }
  gm.send({ type: 'time' });
  const taken = (await gm.reply('time')).at - loadStart;
  const heard = (await watcher.quiet()) - loadStart;

  // A player moves pieces, and another sees them move.
  const byId = new Map(model.objects.map((context) => [context.identifier, context]));
  const sentAt = new Map<string, number>();
  const move = (identifier: string, step: number) => {
    const old = byId.get(identifier) as ObjectContext;
    const moved = { ...old, majorVersion: old.majorVersion + step, minorVersion: 0.5 };
    byId.set(identifier, moved);
    sentAt.set(`${identifier}@${moved.majorVersion}`, performance.now());
    mover.emit([{ eventName: SyncEvent.UPDATE, data: moved }]);
    return `${identifier}@${moved.majorVersion}`;
  };
  /** How long the move took to reach the watcher. Infinity when it did not come within a minute. */
  const arrival = async (key: string) => {
    const [identifier, major] = key.split('@');
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      const came = watcher.events(
        (event) =>
          event.eventName === SyncEvent.UPDATE &&
          identifierOf(event.data) === identifier &&
          String((event.data as ObjectContext).majorVersion) === major
      )[0];
      if (came) return came.at - (sentAt.get(key) as number);
      await sleep(5);
    }
    return Infinity;
  };
  const moves: string[] = [];
  for (let i = 0; i < UPDATES; i++) {
    moves.push(move(model.characters[i % model.characters.length], 1));
    await sleep(UPDATE_EVERY_MS);
  }
  const moveTimes: number[] = [];
  for (const key of moves) moveTimes.push(await arrival(key));

  // After a quiet spell, long enough for the object to be evicted where it is.
  await sleep(15_000);
  const idleMove = await arrival(move(model.characters[0], 1));

  // Dice rolled on the server.
  const rollTimes: number[] = [];
  for (let i = 0; i < ROLLS; i++) {
    const identifier = `roll-${index}-${i}`;
    const start = performance.now();
    mover.emit([
      {
        eventName: AuthorityEvent.ROLL_REQUEST,
        data: {
          message: {
            aliasName: 'chat',
            identifier,
            majorVersion: 1,
            minorVersion: 0.5,
            syncData: { parentIdentifier: model.tabs[0], value: '', attributes: {} },
          },
          command: '2d6',
          gameSystem: 'DiceBot',
          speaker: 'mover',
        },
      },
    ]);
    for (;;) {
      const came = watcher.events((event) => identifierOf(event.data) === identifier)[0];
      if (came) {
        rollTimes.push(came.at - start);
        break;
      }
      await sleep(5);
    }
    await sleep(ROLL_EVERY_MS);
  }

  // Someone comes in with nothing, and asks for everything in the catalog.
  const joiner = await Person.open(roomKey);
  const joinStart = performance.now();
  await joiner.hello('joiner');
  const catalog = (await joiner.reply('data')).message.events as {
    eventName: string;
    data: { identifier: string }[];
  }[];
  const wanted = new Set(catalog.flatMap((event) => event.data.map((item) => item.identifier)));
  const asked = [...wanted];
  for (let i = 0; i < asked.length; i += REQUEST_FRAME) {
    joiner.emit(
      asked.slice(i, i + REQUEST_FRAME).map((identifier) => ({ eventName: SyncEvent.REQUEST, data: identifier })),
      AUTHORITY_PEER_ID
    );
  }
  const answered = () =>
    new Set(
      joiner.events((event) => wanted.has(identifierOf(event.data) as string)).map((event) => identifierOf(event.data))
    ).size;
  while (answered() < wanted.size) await sleep(20);
  const joined = Math.max(...joiner.events(() => true).map((event) => event.at)) - joinStart;

  for (const person of [gm, mover, watcher, joiner]) person.close();
  return {
    'load: all heard (ms)': heard,
    'load: all taken (ms)': taken,
    'move p50 (ms)': percentile(moveTimes, 50),
    'move p99 (ms)': percentile(moveTimes, 99),
    'move after 15 s idle (ms)': idleMove,
    'roll p50 (ms)': percentile(rollTimes, 50),
    'roll p99 (ms)': percentile(rollTimes, 99),
    'join: all received (ms)': joined,
  };
};

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('how long people in a room wait', () => {
  for (const scale of __LATENCY_SCALES__.split(',') as Scale[]) {
    it(`in a ${scale} room`, async () => {
      const runs: RunResult[] = [];
      for (let i = 0; i < __LATENCY_RUNS__; i++) runs.push(await runOnce(scale, i));
      const keys = Object.keys(runs[0]) as (keyof RunResult)[];
      const summary = Object.fromEntries(
        keys.map((key) => [key, Math.round(median(runs.map((run) => run[key])) * 10) / 10])
      );
      console.log(
        `\n${scale} room (${buildRoom(scale).objects.length} objects, scale ${SCALES[scale]}), median of ${runs.length} runs`
      );
      for (const [key, value] of Object.entries(summary))
        console.log(`${key.padEnd(28)} ${String(value).padStart(10)}`);
      console.log(`JSON ${JSON.stringify({ scale, summary, runs })}`);
    });
  }
});
