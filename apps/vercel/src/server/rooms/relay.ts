import { decode, encode } from '@msgpack/msgpack';

import type { KeyOf, Redis } from '../redis.js';

// When a room's WebSocket lands on an instance that is not the room's owner, Redis pub/sub carries
// the traffic to and from the owner.
//
//   r:<key>:in     The owner listens. From other instances: opened, a frame came, closed.
//   i:<ID>:out     An instance listens. From the owner: send, close.
//   r:<key>:ctl    The instances with a WebSocket for the room listen. The owner changes, the room
//                  was deleted.
//   i:<ID>         The mark that an instance is alive. Extended every HEARTBEAT_MS.
//
// The traffic from one instance goes in order over one connection, so the order within one
// WebSocket does not change.

/** How long the mark that an instance is alive lasts, and how often it is extended (milliseconds). */
export const INSTANCE_TTL_MS = 15_000;
export const HEARTBEAT_MS = 5_000;

/** The limit on how much one publish carries. Anything over it is sent in parts. */
export const PART_BYTES = 512 * 1024;

/** To the owner. */
export type Inbound =
  | { t: 'open'; c: string; i: string }
  | { t: 'frame'; c: string; d: Uint8Array | string }
  | { t: 'close'; c: string; rotated: boolean };

/** To an instance. */
export type Outbound =
  { t: 'frame'; c: string; d: Uint8Array | string } | { t: 'close'; c: string; code: number; reason: string };

/** To the instances with a WebSocket for the room. */
export interface Control {
  t: 'moved';
}

/** To the owner alone. */
export interface OwnerControl {
  t: 'delete';
}

/** One of the parts. m is the number the sender gives each message. */
interface Part {
  t: 'part';
  m: number;
  n: number;
  of: number;
  d: Uint8Array;
}

type Listener<T> = (message: T) => void;

export class Relay {
  private subscriber: Redis | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sent = 0;
  /** Holds what comes in parts until all the parts are there. Kept for each sender's channel and message. */
  private readonly parts = new Map<string, Uint8Array[]>();

  constructor(
    private readonly redis: Redis,
    private readonly key: KeyOf,
    readonly instance: string,
    private readonly timing = { ttlMs: INSTANCE_TTL_MS, heartbeatMs: HEARTBEAT_MS }
  ) {}

  inboundOf = (roomKey: string) => this.key('r', roomKey, 'in');
  outboundOf = (instance: string) => this.key('i', instance, 'out');
  controlOf = (roomKey: string) => this.key('r', roomKey, 'ctl');
  /** Heard by the owner alone, so that one instance answering means the owner is there. */
  ownerControlOf = (roomKey: string) => this.key('r', roomKey, 'own');
  aliveOf = (instance: string) => this.key('i', instance);

  /** Opens the connection for listening, and starts putting up the mark that this instance is alive. */
  async start(): Promise<void> {
    if (this.subscriber) return;
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err: unknown) => console.error('Redis subscriber error:', err));
    await this.subscriber.connect();
    const beat = () =>
      void this.redis
        .set(this.aliveOf(this.instance), '1', {
          expiration: { type: 'PX', value: this.timing.ttlMs },
        })
        .catch((err: unknown) => console.error('Could not say this instance is alive:', err));
    beat();
    this.heartbeat = setInterval(beat, this.timing.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Stops. Also deletes the mark that this instance is alive. */
  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const subscriber = this.subscriber;
    this.subscriber = null;
    subscriber?.destroy();
    await this.redis.del(this.aliveOf(this.instance));
  }

  /** Whether that instance is alive. */
  async isAlive(instance: string): Promise<boolean> {
    return (await this.redis.exists(this.aliveOf(instance))) === 1;
  }

  /** Sends. Returns how many instances got it. When it is sent in parts, the count for the last part. */
  async publish(channel: string, message: Inbound | Outbound | Control | OwnerControl): Promise<number> {
    const bytes = Buffer.from(encode(message));
    if (bytes.byteLength <= PART_BYTES) return this.redis.publish(channel, bytes);
    const id = ++this.sent;
    const of = Math.ceil(bytes.byteLength / PART_BYTES);
    let received = 0;
    for (let n = 0; n < of; n++) {
      const part: Part = {
        t: 'part',
        m: id,
        n,
        of,
        d: bytes.subarray(n * PART_BYTES, (n + 1) * PART_BYTES),
      };
      received = await this.redis.publish(channel, Buffer.from(encode({ ...part, i: this.instance })));
    }
    return received;
  }

  /** Listens on that channel. What comes in parts is passed on once all the parts are there. */
  async subscribe<T>(channel: string, listener: Listener<T>): Promise<void> {
    await (this.subscriber as Redis).subscribe(
      channel,
      (data: Buffer) => {
        const message = decode(data) as T | (Part & { i: string });
        if ((message as Part).t !== 'part') return listener(message as T);
        const part = message as Part & { i: string };
        const id = `${channel}|${part.i}|${part.m}`;
        const pieces = this.parts.get(id) ?? [];
        pieces.push(part.d);
        if (pieces.length < part.of) {
          this.parts.set(id, pieces);
          return;
        }
        this.parts.delete(id);
        listener(decode(Buffer.concat(pieces)) as T);
      },
      true
    );
  }

  /** Stops listening on that channel. Does nothing if it already stopped (also once the connection is closed). */
  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber?.unsubscribe(channel).catch(() => undefined);
  }
}
