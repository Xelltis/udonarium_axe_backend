import { COME_BACK_CODE } from '../../../contracts/protocol.js';
import type { AssetUploadPolicy, PeerRole } from '../../../contracts/protocol.js';
import { seatBarredBy } from '../../core/moderation/bans.js';
import type { Ban, BanList } from '../../core/moderation/bans.js';
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

/** How long the owner's lease lasts (milliseconds). The owner extends it every LEASE_RENEW_MS. */
export const LEASE_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;

/** How often the room is checked while people are in it (milliseconds). Replaces the Cloudflare version's alarm. */
export const ROOM_TICK_MS = 30_000;

/** How long each wait is while waiting for the room's lease to come free (milliseconds). */
const LEASE_POLL_MS = 100;

/** Extends the lease. Extends it and returns 1 when it is still this owner's. */
const RENEW = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/** Gives the lease back. Deletes it and returns 1 when it is this owner's. */
const RELEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/** Sending and closing, for a connection to a room. */
export interface ConnSocket {
  send(frame: Uint8Array | string): void;
  close(code: number, reason: string): void;
}

/** One connection to a room. */
export interface Conn {
  /** The connection's id. */
  readonly id: string;
  readonly socket: ConnSocket;
  seat: Seat | null;
  /** The instance, for a WebSocket that landed on another instance. Not set for one on this instance. */
  readonly instance?: string;
  /** The sender's IP address, for the operator's bans. */
  readonly address?: string;
}

/** What came of trying to open a room. When another instance is the owner, that instance. */
export type Claim = { room: VercelRoom } | { holder: string };

/** What a room uses, one of each per instance. */
export interface RoomDeps {
  redis: Redis;
  key: KeyOf;
  lobby: RedisLobby;
  /** This instance's id. */
  instance: string;
  /** Seconds from when the last person leaves a room until the room is deleted. */
  retentionSeconds: number;
  /** The secret that tokens are checked with. Null when login is turned off for the room. */
  sessionSecret: (roomKey: string) => string | null;
  /** How assets are stored, as told in welcome. Null when one PUT can store up to the limit for each kind. */
  assetUpload: AssetUploadPolicy | null;
  /** Deletes a room's assets when the room is deleted. */
  deleteAssets: (roomKey: string) => Promise<void>;
  /** The operator's bans as they stand, read for each hello. Never fails (those read last, then). */
  readBans: () => Promise<BanList>;
  /** Work that goes on to the end even after the response is sent. */
  defer: (work: Promise<unknown>) => void;
  tombstoneLimits?: TombstoneLimits;
  /** The intervals of the lease and the check (milliseconds). The tests make them short. */
  timing?: { leaseMs: number; renewMs: number; tickMs: number };
  /** Whether that instance is alive. When it is not, waits for its lease to run out. */
  isAlive?: (instance: string) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One room. While this instance is the room's owner (holds the lease), it keeps the room's state in
 * memory and leaves relaying and syncing to RoomEngine. The counterpart of the Cloudflare version's
 * RoomDurableObject.
 *
 * The room's state (objects, roles, whether people are in) is kept in Redis, and written only while
 * this instance is the owner (fencedWrite).
 */
export class VercelRoom implements RoomHost<Conn> {
  readonly engine = new RoomEngine<Conn>(this);
  private readonly conns = new Set<Conn>();
  private deleting = false;
  private released = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  /** The queue of writes to Redis, in order. Writes only while this instance is the owner. */
  private writing: Promise<void> = Promise.resolve();
  private lobbyQueue: Promise<void> = Promise.resolve();
  /** Called when the room is let go. */
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
   * Opens a room. When the room exists, takes the lease and reads the state. When another instance
   * that is alive holds the lease, returns that instance (to relay to it). When the owner has gone
   * down, waits for the lease to run out. When there is no room, returns a room that only refuses
   * whoever connects.
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
      // Waits when this instance's earlier room is letting go. When another instance is alive, the
      // room is that instance's.
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
    // The seats an owner that went away left behind are nobody's now: everybody gets back in here.
    room.persist([{ command: 'DEL', key: keys.seats, args: [] }]);
    room.start();
    return { room };
  }

  /** Opens a room. Waits until another instance that owns it lets go (for running it on this instance). */
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
   * The check. Clears away the seats whose token has run out and the cursors of people not there,
   * and brings the head count in the list up to date. When people are in, pushes the time to delete
   * the room later.
   */
  tick(): void {
    if (!this.meta || this.released) return;
    this.engine.expireSeats();
    this.engine.dropStrayCursors();
    if (this.engine.seats().length > 0) this.persist([this.expiry()]);
    this.lobbyChanged(this.roomKey);
    this.dropLostInstances().catch((err: unknown) => console.error('Could not look for lost instances:', err));
  }

  /** Treats the connections on a lost instance (one whose alive mark ran out) as having left. */
  private async dropLostInstances(): Promise<void> {
    const isAlive = this.deps.isAlive;
    if (!isAlive) return;
    for (const conn of [...this.conns]) {
      if (conn.instance && !(await isAlive(conn.instance)) && this.conns.has(conn)) this.closed(conn);
    }
  }

  // ---- Connections ----

  /** Takes a connection. */
  accept(conn: Conn): void {
    this.conns.add(conn);
    this.engine.accept(conn, conn.address);
  }

  /** Closes the connections the operator's ban covers. Returns how many it closed. */
  expel(ban: Ban): number {
    return this.engine.expel(seatBarredBy(ban));
  }

  receive(conn: Conn, message: string | Uint8Array): void {
    this.engine.receive(conn, message);
  }

  /** Counts a ping relayed from another instance, answering whether to answer it. */
  takeRelayedPing(conn: Conn): boolean {
    return this.engine.takeRelayedPing(conn);
  }

  /**
   * A connection dropped. Its seat leaves the copy of the seats other instances read, so that
   * somebody who left may not put assets in from one of them. When this instance has no connections
   * left, lets the room go. The owner runs only while it holds WebSockets of its own (Vercel stops an
   * instance with no calls).
   */
  closed(conn: Conn): void {
    this.engine.closed(conn);
    this.persist([{ command: 'HDEL', key: this.keys.seats, args: [conn.id] }]);
    this.conns.delete(conn);
    if (![...this.conns].some((other) => !other.instance)) this.letGo();
  }

  /** The connections that landed on other instances. */
  get remotes(): Conn[] {
    return [...this.conns].filter((conn) => conn.instance);
  }

  /** How many connections there are now. */
  get size(): number {
    return this.conns.size;
  }

  /** Whether the room has already been let go (this instance is not the owner). */
  get isReleased(): boolean {
    return this.released;
  }

  // ---- Deleting ----

  /**
   * Deletes the room. Only a GM of the room can delete it, or the operator (userId null). Sends
   * room-deleted to the people in it before closing them, takes the room off the list and deletes
   * everything it kept.
   */
  async deleteRoom(userId: string | null): Promise<'deleted' | 'not-found' | 'not-game-master'> {
    if (!this.meta || this.deleting) return 'not-found';
    if (userId !== null && this.roleMap.get(userId) !== 'gm') return 'not-game-master';
    this.record('delete', userId === null ? 'operator' : 'gm', this.engine.seats().length);
    this.engine.closeAll();
    await this.wipe();
    return 'deleted';
  }

  /**
   * A GM of this room, or the operator, deleted it on another instance (that instance checked, and
   * also marked it to be deleted). Sends room-deleted to the people in it before closing them, and
   * deletes the rest.
   */
  async deletedElsewhere(byOperator = false): Promise<void> {
    if (!this.meta || this.deleting) return;
    this.record('delete', byOperator ? 'operator' : 'gm', this.engine.seats().length);
    this.engine.closeAll();
    await this.wipe();
  }

  /**
   * Takes the room off the list and deletes its assets and everything it kept. It writes first that
   * deleting has begun, so even if the server goes down partway, the room does not go back to being
   * one that people can join, and the sweep deletes the rest.
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

  // ---- Stepping down as owner ----

  /** The lease was lost (another instance took the room). Has the people connected reconnect. */
  stepDown(): void {
    if (this.released) return;
    for (const conn of this.conns) this.close(conn, COME_BACK_CODE, 'moved');
    this.letGo();
  }

  /**
   * Lets the room go. Even when that fails (Redis went down), the lease runs out and another instance
   * takes it. The writing goes on after the last call, as the room's other work does.
   */
  private letGo(): void {
    this.deps.defer(this.release().catch((err: unknown) => console.error('Could not let the room go:', err)));
  }

  /** Writes the changes gathered so far, and gives the lease back once they are written. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    for (const timer of this.timers) clearInterval(timer);
    this.onRelease();
    // Changes made just after the last person left are also written before the lease goes back.
    // They cannot be written after that.
    if (this.room()) this.engine.flushNow();
    await this.settle();
    if (this.lease) {
      await this.deps.redis.eval(RELEASE, { keys: [this.keys.lease], arguments: [this.lease] });
    }
  }

  /** Waits until the writes under way are done. */
  async settle(): Promise<void> {
    await this.objects?.settle();
    await this.writing;
    await this.lobbyQueue;
  }

  // ---- What RoomEngine is given ----

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

  /** The role of each logged-in person. Kept in memory, and written to Redis in the background. */
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
   * The room is not deleted while people are in. Each check pushes the time to delete it later. When
   * the owner goes down and nobody pushes it any more, the room goes away one retention period after
   * it was last checked.
   */
  occupied(): void {
    this.persist([{ command: 'HDEL', key: this.keys.meta, args: ['emptiedAt'] }, this.expiry()]);
  }

  /** Nobody is left. The retention period is counted from here. */
  emptied(): void {
    this.persist([{ command: 'HSET', key: this.keys.meta, args: ['emptiedAt', String(Date.now())] }, this.expiry()]);
  }

  /** Sets the time to delete the room to one retention period from now. */
  private expiry(): Op {
    return {
      command: 'ZADD',
      key: expiryKeyOf(this.deps.key),
      args: [String(Date.now() + this.deps.retentionSeconds * 1000), this.roomKey],
    };
  }

  /** Updates the head count and GMs in the list, in order. The list does not take notices for a deleted room. */
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

  /** Writes what happened in the room as one line of structured log. */
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

  listed(): Promise<void> {
    return this.lobbyQueue;
  }

  bans(): Promise<BanList> {
    return this.deps.readBans();
  }

  defer(work: Promise<unknown>): void {
    this.deps.defer(work);
  }

  /** Writes as the owner, in order. */
  private persist(ops: Op[]): void {
    this.writing = this.writing
      .then(async () => {
        if (!(await fencedWrite(this.deps.redis, this.keys, this.lease, ops))) this.stepDown();
      })
      .catch((err: unknown) => console.error('Could not keep the room:', err));
    this.deps.defer(this.writing);
  }
}

/** Deletes everything the room kept from Redis. */
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
