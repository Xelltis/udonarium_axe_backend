import { decode, encode } from '@msgpack/msgpack';

import type { KeyOf, Redis } from '../redis.js';

// 部屋の WebSocket が、部屋の持ち主でないインスタンスに着いたとき、持ち主との行き来を Redis の
// pub/sub で運ぶ。
//
//   r:<鍵>:in       持ち主が受ける。ほかのインスタンスから、つないだ・届いた・切れた
//   i:<ID>:out      インスタンスが受ける。持ち主から、送る・閉じる
//   r:<鍵>:ctl      部屋に WebSocket を持つインスタンスが受ける。持ち主が替わる・部屋を消した
//   i:<ID>          インスタンスが生きている印。HEARTBEAT_MS ごとに延ばす
//
// 1つのインスタンスからの行き来は1本の接続で順に送るので、1つの WebSocket の中の順は変わらない

/** インスタンスが生きている印が続く時間と、延ばす間（ミリ秒） */
export const INSTANCE_TTL_MS = 15_000;
export const HEARTBEAT_MS = 5_000;

/** 1回の publish に載せる量の上限。超えるものは分けて送る */
export const PART_BYTES = 512 * 1024;

/** 持ち主へ */
export type Inbound =
  | { t: 'open'; c: string; i: string }
  | { t: 'frame'; c: string; d: Uint8Array | string }
  | { t: 'close'; c: string; rotated: boolean };

/** インスタンスへ */
export type Outbound =
  { t: 'frame'; c: string; d: Uint8Array | string } | { t: 'close'; c: string; code: number; reason: string };

/** 部屋の WebSocket を持つインスタンスへ */
export type Control = { t: 'moved' } | { t: 'delete' };

/** 分けたものの1つ。m は送る側がメッセージごとに振る番号 */
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
  /** 分けて届いたものを、そろうまで置いておく。送り手のチャンネルとメッセージごと */
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
  aliveOf = (instance: string) => this.key('i', instance);

  /** 受けるための接続をつなぎ、生きている印を置き始める */
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

  /** やめる。生きている印も消す */
  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const subscriber = this.subscriber;
    this.subscriber = null;
    subscriber?.destroy();
    await this.redis.del(this.aliveOf(this.instance));
  }

  /** そのインスタンスが生きているか */
  async isAlive(instance: string): Promise<boolean> {
    return (await this.redis.exists(this.aliveOf(instance))) === 1;
  }

  /** 送る。受けたものの数（受け手のインスタンスの数）を返す。分けて送ったときは、最後のものの数 */
  async publish(channel: string, message: Inbound | Outbound | Control): Promise<number> {
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

  /** そのチャンネルを受ける。分けて届いたものは、そろってから渡す */
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

  /** そのチャンネルを受けるのをやめる。もうやめていれば（接続を閉じたあとも）何もしない */
  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber?.unsubscribe(channel).catch(() => undefined);
  }
}
