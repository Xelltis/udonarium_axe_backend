import { COME_BACK_CODE } from '../../../contracts/protocol.js';
import type { AssetUploadPolicy, PeerRole } from '../../../contracts/protocol.js';
import { RoomEngine } from '../../core/rooms/engine.js';
import type { RoleBook, RoomEvent, RoomFacts, RoomHost, Seat } from '../../core/rooms/host.js';
import type { TombstoneLimits } from '../../core/rooms/object-index.js';
import type { RedisLobby } from '../lobby.js';
import { binaryOf } from '../redis.js';
import type { KeyOf, Redis } from '../redis.js';
import { fencedWrite } from './fence.js';
import type { Op } from './fence.js';
import { expiryKeyOf, readRoomMeta, roomKeysOf } from './keys.js';
import type { RoomKeys, RoomMeta } from './keys.js';
import { RedisRoomStore } from './store.js';

/** 持ち主の lease が続く時間（ミリ秒）。持ち主は LEASE_RENEW_MS ごとに延ばす */
export const LEASE_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;

/** 人がいるあいだ、部屋を見回る間（ミリ秒）。Cloudflare 版の alarm の代わり */
export const ROOM_TICK_MS = 30_000;

/** 部屋の lease が空くのを待つ間（ミリ秒） */
const LEASE_POLL_MS = 100;

/** lease を延ばす。まだ自分のものなら延ばして 1 */
const RENEW = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/** lease を返す。自分のものなら消して 1 */
const RELEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/** 部屋への接続の、送ると閉じる */
export interface ConnSocket {
  send(frame: Uint8Array | string): void;
  close(code: number, reason: string): void;
}

/** 部屋への1つの接続 */
export interface Conn {
  /** 接続の ID */
  readonly id: string;
  readonly socket: ConnSocket;
  seat: Seat | null;
  /** ほかのインスタンスに着いた WebSocket なら、そのインスタンス。このインスタンスのものなら無い */
  readonly instance?: string;
}

/** 部屋を開こうとした結果。ほかのインスタンスが持ち主なら、そのインスタンス */
export type Claim = { room: VercelRoom } | { holder: string };

/** 部屋が使う、インスタンスで1つのもの */
export interface RoomDeps {
  redis: Redis;
  key: KeyOf;
  lobby: RedisLobby;
  /** このインスタンスの ID */
  instance: string;
  /** 部屋から最後の1人が出てから、部屋を消すまでの秒数 */
  retentionSeconds: number;
  /** トークンを確かめる鍵。部屋ごとにログインを外していれば null */
  sessionSecret: (roomKey: string) => string | null;
  /** welcome で知らせるアセットの置き方。1回の PUT で種類ごとの上限まで置けるなら null */
  assetUpload: AssetUploadPolicy | null;
  /** 部屋を消すときに、部屋のアセットを消す */
  deleteAssets: (roomKey: string) => Promise<void>;
  /** 返したあとも終わるまで続ける仕事 */
  defer: (work: Promise<unknown>) => void;
  tombstoneLimits?: TombstoneLimits;
  /** lease と見回りの間（ミリ秒）。テストで短くする */
  timing?: { leaseMs: number; renewMs: number; tickMs: number };
  /** そのインスタンスが生きているか。生きていなければ、その lease が切れるのを待つ */
  isAlive?: (instance: string) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 1つの部屋。このインスタンスが部屋の持ち主（lease を持つ）のあいだ、部屋の状態をメモリに置き、
 * RoomEngine に中継と同期を任せる。Cloudflare 版の RoomDurableObject にあたる。
 *
 * 部屋の状態（オブジェクト・役割・人がいるか）は Redis に置き、書くのは持ち主のときだけ（fencedWrite）
 */
export class VercelRoom implements RoomHost<Conn> {
  readonly engine = new RoomEngine<Conn>(this);
  private readonly conns = new Set<Conn>();
  private deleting = false;
  private released = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  /** Redis に書く順番。持ち主のときだけ書く */
  private writing: Promise<void> = Promise.resolve();
  private lobbyQueue: Promise<void> = Promise.resolve();
  /** 放したときに呼ぶ */
  onRelease: () => void = () => undefined;

  private constructor(
    private readonly deps: RoomDeps,
    readonly roomKey: string,
    private readonly keys: RoomKeys,
    private meta: RoomMeta | null,
    private readonly lease: string,
    private readonly roleMap: Map<string, PeerRole>,
    private readonly objects: RedisRoomStore | null
  ) {}

  /**
   * 部屋を開く。部屋があれば lease を取り、状態を読む。生きているほかのインスタンスが lease を持って
   * いれば、そのインスタンスを返す（そちらへ中継する）。持ち主が落ちていれば、lease が切れるのを待つ。
   * 部屋が無ければ、つないできた人を断るだけの部屋を返す
   */
  static async claim(deps: RoomDeps, roomKey: string): Promise<Claim> {
    const keys = roomKeysOf(deps.key, roomKey);
    const meta = await readRoomMeta(deps.redis, deps.key, roomKey);
    if (!meta) return { room: new VercelRoom(deps, roomKey, keys, null, '', new Map(), null) };
    const epoch = await deps.redis.incr(keys.epoch);
    const lease = `${deps.instance}:${epoch}`;
    const leaseMs = deps.timing?.leaseMs ?? LEASE_MS;
    while (
      (await deps.redis.set(keys.lease, lease, {
        condition: 'NX',
        expiration: { type: 'PX', value: leaseMs },
      })) === null
    ) {
      const holder = (await deps.redis.get(keys.lease))?.split(':')[0];
      // このインスタンスの前の部屋が放すところなら待つ。ほかのインスタンスが生きていれば、そちらの部屋
      if (holder && holder !== deps.instance && (await deps.isAlive?.(holder))) return { holder };
      await sleep(LEASE_POLL_MS);
    }
    const write = async (ops: Op[]) => {
      if (!(await fencedWrite(deps.redis, keys, lease, ops))) room.stepDown();
    };
    const [roles, objects] = await Promise.all([
      deps.redis.hGetAll(keys.roles),
      RedisRoomStore.load(binaryOf(deps.redis), keys, write, deps.tombstoneLimits),
    ]);
    const room: VercelRoom = new VercelRoom(
      deps,
      roomKey,
      keys,
      meta,
      lease,
      new Map(Object.entries(roles) as [string, PeerRole][]),
      objects
    );
    room.start();
    return { room };
  }

  /** 部屋を開く。ほかのインスタンスが持ち主なら、放すまで待つ（このインスタンスで動かすとき） */
  static async open(deps: RoomDeps, roomKey: string): Promise<VercelRoom> {
    for (;;) {
      const claim = await VercelRoom.claim(deps, roomKey);
      if ('room' in claim) return claim.room;
      await sleep(LEASE_POLL_MS);
    }
  }

  private start(): void {
    const timing = this.deps.timing ?? {
      leaseMs: LEASE_MS,
      renewMs: LEASE_RENEW_MS,
      tickMs: ROOM_TICK_MS,
    };
    const renew = setInterval(() => {
      void this.deps.redis
        .eval(RENEW, { keys: [this.keys.lease], arguments: [this.lease, String(timing.leaseMs)] })
        .then((renewed) => {
          if (renewed !== 1) this.stepDown();
        })
        .catch((err: unknown) => console.error('Could not keep the room’s lease:', err));
    }, timing.renewMs);
    const tick = setInterval(() => this.tick(), timing.tickMs);
    this.timers = [renew, tick];
    for (const timer of this.timers) timer.unref();
  }

  /**
   * 見回り。トークンの切れた席と、いない人のカーソルを片付け、一覧の人数を合わせる。人がいれば、消す時刻を
   * 先へ延ばす
   */
  tick(): void {
    if (!this.meta || this.released) return;
    this.engine.expireSeats();
    this.engine.dropStrayCursors();
    if (this.engine.seats().length > 0) this.persist([this.expiry()]);
    this.lobbyChanged(this.roomKey);
    this.dropLostInstances().catch((err: unknown) => console.error('Could not look for lost instances:', err));
  }

  /** 落ちたインスタンス（生きている印の切れたもの）に着いていた接続を、出たことにする */
  private async dropLostInstances(): Promise<void> {
    const isAlive = this.deps.isAlive;
    if (!isAlive) return;
    for (const conn of [...this.conns]) {
      if (conn.instance && !(await isAlive(conn.instance)) && this.conns.has(conn)) this.closed(conn);
    }
  }

  // ---- 接続 ----

  /** 接続を受ける */
  accept(conn: Conn): void {
    this.conns.add(conn);
    this.engine.accept(conn);
  }

  receive(conn: Conn, message: string | Uint8Array): void {
    this.engine.receive(conn, message);
  }

  /**
   * 接続が切れた。このインスタンスの接続が無くなったら、部屋を放す。持ち主は、自分の WebSocket を
   * 持っているあいだだけ動いている（Vercel は、呼び出しの無いインスタンスを止めてしまう）
   */
  closed(conn: Conn): void {
    this.engine.closed(conn);
    this.conns.delete(conn);
    if (![...this.conns].some((other) => !other.instance)) this.letGo();
  }

  /** ほかのインスタンスに着いた接続 */
  get remotes(): Conn[] {
    return [...this.conns].filter((conn) => conn.instance);
  }

  /** いまの接続の数 */
  get size(): number {
    return this.conns.size;
  }

  /** もう放した（持ち主でない） */
  get isReleased(): boolean {
    return this.released;
  }

  // ---- 削除 ----

  /**
   * 部屋を削除する。その部屋の GM だけが削除できる。入っている人には room-deleted を送ってから閉じ、
   * 一覧から外して置いたものをすべて消す
   */
  async deleteRoom(userId: string): Promise<'deleted' | 'not-found' | 'not-game-master'> {
    if (!this.meta || this.deleting) return 'not-found';
    if (this.roleMap.get(userId) !== 'gm') return 'not-game-master';
    this.record('delete', 'gm', this.engine.seats().length);
    this.engine.closeAll();
    await this.wipe();
    return 'deleted';
  }

  /**
   * ほかのインスタンスで、この部屋の GM が部屋を削除した（そちらで確かめて、消す印も付けてある）。
   * 入っている人に room-deleted を送ってから閉じ、残りを消す
   */
  async deletedElsewhere(): Promise<void> {
    if (!this.meta || this.deleting) return;
    this.record('delete', 'gm', this.engine.seats().length);
    this.engine.closeAll();
    await this.wipe();
  }

  /**
   * 部屋を一覧から外し、部屋のアセットと置いたものをすべて消す。消しはじめたことを先に書くので、途中で
   * 落ちても入れる部屋には戻らず、掃除が残りを消す
   */
  async wipe(): Promise<void> {
    this.deleting = true;
    this.engine.stopFlushing();
    try {
      await this.deps.redis
        .multi()
        .hSet(this.keys.meta, 'deleting', '1')
        .zAdd(expiryKeyOf(this.deps.key), { score: Date.now(), value: this.roomKey })
        .exec();
      await this.writing;
      await this.deps.lobby.remove(this.roomKey);
      await this.deps
        .deleteAssets(this.roomKey)
        .catch((err: unknown) => console.error('Room asset deletion failed:', err));
      await wipeRoom(this.deps.redis, this.deps.key, this.roomKey);
    } catch (err) {
      console.error('Room deletion failed, to be tried again:', err);
    }
    this.meta = null;
    await this.release();
  }

  // ---- 持ち主をやめる ----

  /** lease を失った（ほかのインスタンスが部屋を取った）。つないでいる人には、つなぎ直してもらう */
  stepDown(): void {
    if (this.released) return;
    for (const conn of this.conns) this.close(conn, COME_BACK_CODE, 'moved');
    this.letGo();
  }

  /** 放す。うまく放せなくても（Redis が落ちた）、lease は切れて、ほかのインスタンスが取る */
  private letGo(): void {
    this.release().catch((err: unknown) => console.error('Could not let the room go:', err));
  }

  /** まとめておいた変更を書き、書き終えてから lease を返す */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    for (const timer of this.timers) clearInterval(timer);
    this.onRelease();
    // 最後の1人が出た直後の変更も、lease を返す前に書く。返したあとでは書けない
    if (this.room()) this.engine.flushNow();
    await this.settle();
    if (this.lease) {
      await this.deps.redis.eval(RELEASE, { keys: [this.keys.lease], arguments: [this.lease] });
    }
  }

  /** 書きかけのものを書き終えるまで待つ */
  async settle(): Promise<void> {
    await this.objects?.settle();
    await this.writing;
    await this.lobbyQueue;
  }

  // ---- RoomEngine に渡すもの ----

  connections(): Conn[] {
    return [...this.conns];
  }

  seatOf(conn: Conn): Seat | null {
    return conn.seat;
  }

  setSeat(conn: Conn, seat: Seat): void {
    conn.seat = seat;
    this.persist(
      seat.closed
        ? [{ command: 'HDEL', key: this.keys.seats, args: [conn.id] }]
        : [{ command: 'HSET', key: this.keys.seats, args: [conn.id, JSON.stringify(seat)] }]
    );
  }

  send(conn: Conn, frame: Uint8Array): void {
    conn.socket.send(frame);
  }

  close(conn: Conn, code: number, reason: string): void {
    conn.socket.close(code, reason);
  }

  room(): RoomFacts | null {
    if (!this.meta || this.deleting) return null;
    return { roomKey: this.meta.roomKey, password: this.meta.password };
  }

  wiping(): boolean {
    return this.deleting;
  }

  store(): RedisRoomStore {
    return this.objects as RedisRoomStore;
  }

  /** ログインした人ごとの役割。メモリに置き、Redis には後ろで書く */
  readonly roles: RoleBook = {
    roleOf: (userId) => this.roleMap.get(userId) ?? null,
    add: (userId, role) => this.setRole(userId, role),
    set: (userId, role) => this.setRole(userId, role),
    gameMasterCount: () => [...this.roleMap.values()].filter((role) => role === 'gm').length,
  };

  private setRole(userId: string, role: PeerRole): void {
    this.roleMap.set(userId, role);
    this.persist([{ command: 'HSET', key: this.keys.roles, args: [userId, role] }]);
  }

  sessionSecret(): string | null {
    return this.deps.sessionSecret(this.roomKey);
  }

  assetUploadPolicy(): AssetUploadPolicy | null {
    return this.deps.assetUpload;
  }

  /**
   * 人がいるあいだは消さない。消す時刻は、見回りのたびに先へ延ばす。持ち主が落ちて延ばす者がいなくなれば、
   * 最後に見たときから保持期間のあとに消える
   */
  occupied(): void {
    this.persist([{ command: 'HDEL', key: this.keys.meta, args: ['emptiedAt'] }, this.expiry()]);
  }

  /** だれもいなくなった。ここから保持期間を数える */
  emptied(): void {
    this.persist([{ command: 'HSET', key: this.keys.meta, args: ['emptiedAt', String(Date.now())] }, this.expiry()]);
  }

  /** 消す時刻を、いまから保持期間のあとにする */
  private expiry(): Op {
    return {
      command: 'ZADD',
      key: expiryKeyOf(this.deps.key),
      args: [String(Date.now() + this.deps.retentionSeconds * 1000), this.roomKey],
    };
  }

  /** 一覧の人数と GM を直す。知らせる順に並べる。部屋が消えたあとの知らせは、一覧が受けない */
  lobbyChanged(roomKey: string): void {
    this.lobbyQueue = this.lobbyQueue
      .then(async () => {
        const gameMasters = [...this.roleMap].filter(([, role]) => role === 'gm');
        await this.deps.lobby.setMembers(roomKey, this.engine.seats().length);
        await this.deps.lobby.setGameMasters(
          roomKey,
          gameMasters.map(([userId]) => userId)
        );
      })
      .catch((err: unknown) => console.error('Lobby update failed:', err));
    this.deps.defer(this.lobbyQueue);
  }

  /** 部屋で起きたことを、構造化したログに1行書く */
  record(event: RoomEvent, detail: string, value: number): void {
    if (!this.meta) return;
    console.info(
      JSON.stringify({
        metric: 'room',
        room: this.roomKey,
        host: this.meta.host,
        event,
        detail,
        value,
      })
    );
  }

  defer(work: Promise<unknown>): void {
    this.deps.defer(work);
  }

  /** 持ち主として、順に書く */
  private persist(ops: Op[]): void {
    this.writing = this.writing
      .then(async () => {
        if (!(await fencedWrite(this.deps.redis, this.keys, this.lease, ops))) this.stepDown();
      })
      .catch((err: unknown) => console.error('Could not keep the room:', err));
    this.deps.defer(this.writing);
  }
}

/** 部屋の置いたものを Redis からすべて消す */
export const wipeRoom = async (redis: Redis, key: KeyOf, roomKey: string): Promise<void> => {
  const keys = roomKeysOf(key, roomKey);
  const chunked = await redis.sMembers(keys.chunked);
  await redis
    .multi()
    .del([
      keys.meta,
      keys.roles,
      keys.seats,
      keys.objects,
      keys.tombstones,
      keys.chunked,
      keys.epoch,
      ...chunked.map(keys.chunks),
    ])
    .zRem(expiryKeyOf(key), roomKey)
    .exec();
};
