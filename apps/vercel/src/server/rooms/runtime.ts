import type { WebSocket } from 'ws';

import { COME_BACK_CODE, PING, PONG } from '../../../contracts/protocol.js';
import { expiryKeyOf, readRoomMeta, roomKeysOf } from './keys.js';
import type { Control, Inbound, Outbound, Relay } from './relay.js';
import { LEASE_MS, VercelRoom } from './room.js';
import type { Claim, Conn, ConnSocket, RoomDeps } from './room.js';

/**
 * How long a seat is kept after the server closed it to have it reconnect (rotate), in
 * milliseconds. When the same person reconnects in that time, the seat is swapped without showing
 * the others anyone leaving or coming in.
 */
export const PARK_MS = 15_000;

/** How long to wait before trying again when no owner is found (milliseconds). */
const RETRY_MS = 100;

export interface RuntimeOptions {
  /** Seconds before the server closes a room's WebSocket itself and has it reconnect. */
  socketSeconds: number;
  parkMs?: number;
}

/** How one WebSocket is tied to the room. */
interface Link {
  /** What came in before the owner was settled. */
  waiting: (string | Uint8Array)[];
  /** Where what comes in is passed. Set once the owner is settled. */
  route: ((message: string | Uint8Array) => void) | null;
  /** What to do when the connection drops. Set once the owner is settled. */
  leave: (() => void) | null;
  rotated: boolean;
  gone: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The code to close back with. The code the other side closed with when it can be sent (1000 or
 * 3000 to 4999), or else 1000. The same as the Cloudflare version's webSocketClose.
 */
const closeBackCode = (code: number | undefined): number =>
  code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000;

/**
 * Turns a ws WebSocket into the shape a room uses. ws itself closes back to a side that closed, so
 * the code it uses then is made the same as in the Cloudflare version.
 */
const socketOf = (ws: WebSocket): ConnSocket => {
  const close = ws.close.bind(ws);
  ws.close = (code?: number, reason?: string | Buffer) => close(closeBackCode(code), reason);
  return {
    send: (frame) => {
      try {
        ws.send(frame);
      } catch {
        // It is closing. The close event counts it as having left.
      }
    },
    close: (code, reason) => {
      try {
        close(code, reason);
      } catch {
        // It is already closed.
      }
    },
  };
};

/**
 * This instance's rooms. Takes the WebSockets that connect to a room, and hands them to the room
 * when this instance is its owner, or relays them to the owner when another instance is.
 */
export class RoomRuntime {
  /** The rooms this instance owns (or is trying to own). */
  private readonly rooms = new Map<string, Promise<Claim>>();
  /** The WebSockets relayed to other instances, by connection id (to pass on what comes from the owner). */
  private readonly proxies = new Map<string, ConnSocket>();
  /** The WebSockets relayed to other instances, by room (to have them reconnect when the owner changes). */
  private readonly watched = new Map<string, Set<ConnSocket>>();
  /** The rooms that, as owner, take WebSockets from other instances. */
  private readonly served = new WeakSet<VercelRoom>();
  private readonly parkMs: number;
  private started: Promise<void> | null = null;
  /** The closings, still under way, of the listeners of rooms that were let go. */
  private readonly unserving = new Set<Promise<void>>();

  constructor(
    private readonly deps: RoomDeps,
    private readonly options: RuntimeOptions,
    private readonly relay?: Relay
  ) {
    this.parkMs = options.parkMs ?? PARK_MS;
  }

  /** Starts listening to the relay. */
  private ready(): Promise<void> {
    const relay = this.relay;
    if (!relay) return Promise.resolve();
    this.started ??= relay
      .start()
      .then(() => relay.subscribe<Outbound>(relay.outboundOf(relay.instance), (message) => this.fromOwner(message)));
    return this.started;
  }

  /** Tries to become the room's owner. When another instance is the owner, returns that instance. */
  private claim(roomKey: string): Promise<Claim> {
    let pending = this.rooms.get(roomKey);
    if (!pending) {
      const claiming = VercelRoom.claim(this.deps, roomKey);
      pending = claiming;
      this.rooms.set(roomKey, claiming);
      claiming.then(
        (claim) => {
          if (!('room' in claim)) {
            this.rooms.delete(roomKey);
            return;
          }
          const { room } = claim;
          room.onRelease = () => {
            if (this.rooms.get(roomKey) === claiming) this.rooms.delete(roomKey);
            const unserving = this.unserve(room).finally(() => this.unserving.delete(unserving));
            this.unserving.add(unserving);
          };
          this.serve(room).catch((err: unknown) =>
            console.error('Could not hear the room’s sockets on other instances:', err)
          );
        },
        () => this.rooms.delete(roomKey)
      );
    }
    // When the room was let go while waiting (nobody was left), tries again.
    return pending.then((claim) => ('room' in claim && claim.room.isReleased ? this.claim(roomKey) : claim));
  }

  /** Opens a room on this instance. When another instance is the owner, waits until it lets go. */
  async room(roomKey: string): Promise<VercelRoom> {
    for (;;) {
      const claim = await this.claim(roomKey);
      if ('room' in claim) return claim.room;
      await sleep(RETRY_MS);
    }
  }

  /** The room this instance owns (or is trying to own), or null when there is none. */
  async openRoom(roomKey: string): Promise<VercelRoom | null> {
    const claim = await this.rooms.get(roomKey);
    return claim && 'room' in claim ? claim.room : null;
  }

  /** Lets go of all this instance's rooms, and stops the relay too. */
  async close(): Promise<void> {
    for (const pending of [...this.rooms.values()]) {
      const claim = await pending;
      if ('room' in claim) await claim.room.release();
    }
    await Promise.all(this.unserving);
    await this.relay?.stop();
  }

  /** Calls run inside the room. When nobody is connected, lets the room go once it is done. */
  async withRoom<T>(roomKey: string, run: (room: VercelRoom) => T | Promise<T>): Promise<T> {
    const room = await this.room(roomKey);
    try {
      return await run(room);
    } finally {
      if (room.size === 0) await room.release();
    }
  }

  /**
   * Deletes a room. When this instance is the owner, or nobody is in, deletes it here. When another
   * instance is the owner, checks here that the person is GM, then has the owner delete it (taking
   * it off the list right away).
   */
  async deleteRoom(roomKey: string, userId: string): Promise<'deleted' | 'not-found' | 'not-game-master'> {
    const claim = await this.claim(roomKey);
    if ('room' in claim) {
      const { room } = claim;
      const result = await room.deleteRoom(userId);
      if (room.size === 0) await room.release();
      return result;
    }
    const { redis, key, lobby } = this.deps;
    if (!(await readRoomMeta(redis, key, roomKey))) return 'not-found';
    if ((await redis.hGet(roomKeysOf(key, roomKey).roles, userId)) !== 'gm') {
      return 'not-game-master';
    }
    const relay = this.relay as Relay;
    const control: Control = { t: 'delete' };
    if ((await relay.publish(relay.controlOf(roomKey), control)) === 0) {
      // The owner had gone down. Marks the room to be deleted and leaves the rest to the sweep.
      await redis
        .multi()
        .hSet(roomKeysOf(key, roomKey).meta, 'deleting', '1')
        .zAdd(expiryKeyOf(key), { score: Date.now(), value: roomKey })
        .exec();
    }
    await lobby.remove(roomKey);
    return 'deleted';
  }

  /** Takes a WebSocket that connected to a room. */
  attach(ws: WebSocket, roomKey: string): void {
    const conn: Conn = { id: crypto.randomUUID(), socket: socketOf(ws), seat: null };
    const link: Link = { waiting: [], route: null, leave: null, rotated: false, gone: false };

    // Before the Vercel Function's maximum duration cuts it off, the server closes it itself and
    // has it reconnect.
    const rotation = setTimeout(() => {
      link.rotated = true;
      conn.socket.close(COME_BACK_CODE, 'rotate');
    }, this.options.socketSeconds * 1000);
    rotation.unref();

    ws.on('message', (data, isBinary) => {
      const message = isBinary ? new Uint8Array(data as Buffer) : String(data);
      // Answers PING without passing it to the room (the Cloudflare version answers without waking
      // the room).
      if (message === PING) return conn.socket.send(PONG);
      if (link.route) link.route(message);
      else link.waiting.push(message);
    });
    ws.on('close', () => {
      clearTimeout(rotation);
      link.gone = true;
      link.leave?.();
    });
    ws.on('error', (err) => console.error('Room socket error:', err));

    this.connect(conn, roomKey, link).catch((err: unknown) => {
      console.error('Could not open the room:', err);
      conn.socket.close(1011, 'unavailable');
    });
  }

  /** Finds the owner and connects the WebSocket: to the room when this instance owns it, else via the relay. */
  private async connect(conn: Conn, roomKey: string, link: Link): Promise<void> {
    await this.ready();
    // Looks for the owner for up to twice the lease. Even when the owner has gone down, this
    // instance can become the owner once the lease runs out.
    const until = Date.now() + 2 * (this.deps.timing?.leaseMs ?? LEASE_MS);
    for (;;) {
      const claim = await this.claim(roomKey);
      if ('room' in claim) {
        const { room } = claim;
        link.route = (message) => room.receive(conn, message);
        link.leave = () => {
          if (link.rotated) setTimeout(() => room.closed(conn), this.parkMs).unref();
          else room.closed(conn);
        };
        room.accept(conn);
        for (const message of link.waiting.splice(0)) room.receive(conn, message);
        if (link.gone) link.leave();
        return;
      }
      if (await this.proxy(conn, roomKey, link)) return;
      if (Date.now() > until) return conn.socket.close(COME_BACK_CODE, 'moved');
      await sleep(RETRY_MS);
    }
  }

  /** Relays to the owner. False when the owner does not take it (it just let go, or went down). */
  private async proxy(conn: Conn, roomKey: string, link: Link): Promise<boolean> {
    const relay = this.relay as Relay;
    const inbound = relay.inboundOf(roomKey);
    await this.watch(roomKey, conn.socket);
    const open: Inbound = { t: 'open', c: conn.id, i: relay.instance };
    if ((await relay.publish(inbound, open)) === 0) {
      this.unwatch(roomKey, conn.socket);
      return false;
    }
    this.proxies.set(conn.id, conn.socket);
    // The owner can no longer be reached (it went down). Has the connection reconnect.
    const moved = () => conn.socket.close(COME_BACK_CODE, 'moved');
    // What comes from one WebSocket is sent in the order it came.
    let queue: Promise<unknown> = Promise.resolve();
    const send = (message: Inbound) => {
      queue = queue
        .then(() => relay.publish(inbound, message))
        .then((received) => {
          if (received === 0) moved();
        }, moved);
    };
    link.route = (message) => send({ t: 'frame', c: conn.id, d: message });
    link.leave = () => {
      send({ t: 'close', c: conn.id, rotated: link.rotated });
      this.proxies.delete(conn.id);
      this.unwatch(roomKey, conn.socket);
    };
    for (const message of link.waiting.splice(0)) link.route(message);
    if (link.gone) link.leave();
    return true;
  }

  /** Passes what comes from the owner to the relayed WebSocket. */
  private fromOwner(message: Outbound): void {
    const socket = this.proxies.get(message.c);
    if (!socket) return;
    if (message.t === 'frame') socket.send(message.d);
    else socket.close(message.code, message.reason);
  }

  /** Listens to the notices of a relayed WebSocket's room. When the owner changes (let go), has it reconnect. */
  private async watch(roomKey: string, socket: ConnSocket): Promise<void> {
    const watching = this.watched.get(roomKey);
    if (watching) {
      watching.add(socket);
      return;
    }
    const sockets = new Set([socket]);
    this.watched.set(roomKey, sockets);
    const relay = this.relay as Relay;
    await relay.subscribe<Control>(relay.controlOf(roomKey), (message) => {
      if (message.t !== 'moved') return;
      for (const each of sockets) each.close(COME_BACK_CODE, 'moved');
    });
  }

  private unwatch(roomKey: string, socket: ConnSocket): void {
    const sockets = this.watched.get(roomKey) as Set<ConnSocket>;
    sockets.delete(socket);
    if (sockets.size > 0) return;
    this.watched.delete(roomKey);
    const relay = this.relay as Relay;
    void relay.unsubscribe(relay.controlOf(roomKey));
  }

  /** As the owner, takes the WebSockets that landed on other instances. */
  private async serve(room: VercelRoom): Promise<void> {
    const relay = this.relay;
    if (!relay || !room.room()) return;
    this.served.add(room);
    await this.ready();
    const remotes = new Map<string, Conn>();
    await relay.subscribe<Inbound>(relay.inboundOf(room.roomKey), (message) => {
      if (room.isReleased) return;
      if (message.t === 'open') {
        const out = relay.outboundOf(message.i);
        // Even when it does not get there (that instance went down), the check removes the seat.
        const tell = (outbound: Outbound) => void relay.publish(out, outbound).catch(() => undefined);
        const conn: Conn = {
          id: message.c,
          instance: message.i,
          seat: null,
          socket: {
            send: (frame) => tell({ t: 'frame', c: message.c, d: frame }),
            close: (code, reason) => tell({ t: 'close', c: message.c, code, reason }),
          },
        };
        remotes.set(message.c, conn);
        room.accept(conn);
        return;
      }
      const conn = remotes.get(message.c);
      if (!conn) return;
      if (message.t === 'frame') return room.receive(conn, message.d);
      remotes.delete(message.c);
      if (message.rotated) setTimeout(() => room.closed(conn), this.parkMs).unref();
      else room.closed(conn);
    });
    await relay.subscribe<Control>(relay.controlOf(room.roomKey), (message) => {
      if (message.t === 'delete') void room.deletedElsewhere();
    });
  }

  /** Stepped down as owner. Has the WebSockets that landed on other instances reconnect. */
  private async unserve(room: VercelRoom): Promise<void> {
    const relay = this.relay;
    if (!relay || !this.served.has(room)) return;
    await relay.unsubscribe(relay.inboundOf(room.roomKey));
    await relay.unsubscribe(relay.controlOf(room.roomKey));
    if (room.remotes.length > 0) await relay.publish(relay.controlOf(room.roomKey), { t: 'moved' });
  }
}
