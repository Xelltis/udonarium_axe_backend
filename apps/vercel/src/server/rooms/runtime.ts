import type { WebSocket } from 'ws';

import { COME_BACK_CODE, PING, PONG } from '../../../contracts/protocol.js';
import { expiryKeyOf, readRoomMeta, roomKeysOf } from './keys.js';
import type { Control, Inbound, Outbound, Relay } from './relay.js';
import { LEASE_MS, VercelRoom } from './room.js';
import type { Claim, Conn, ConnSocket, RoomDeps } from './room.js';

/**
 * こちらから閉じてつなぎ直させた（rotate）席を、残しておく時間（ミリ秒）。そのあいだに同じ人が
 * つなぎ直せば、ほかの人には出入りを見せずに席を替える
 */
export const PARK_MS = 15_000;

/** 持ち主が見つからないとき、もう一度試すまでの間（ミリ秒） */
const RETRY_MS = 100;

export interface RuntimeOptions {
  /** 部屋の WebSocket を、こちらから閉じてつなぎ直させるまでの秒数 */
  socketSeconds: number;
  parkMs?: number;
}

/** 1つの WebSocket の、部屋とのつながり */
interface Link {
  /** 持ち主が決まるまでに届いたもの */
  waiting: (string | Uint8Array)[];
  /** 届いたものを渡す先。持ち主が決まってから */
  route: ((message: string | Uint8Array) => void) | null;
  /** 切れたときにすること。持ち主が決まってから */
  leave: (() => void) | null;
  rotated: boolean;
  gone: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 閉じ返すときのコード。閉じてきたコードが送れるもの（1000 か 3000〜4999）ならそのまま、そうでなければ
 * 1000。Cloudflare 版の webSocketClose と同じ
 */
const closeBackCode = (code: number | undefined): number =>
  code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000;

/**
 * ws の WebSocket を、部屋が使う形にする。閉じてきた相手に閉じ返すのは ws が自分で行うので、
 * そのときのコードを Cloudflare 版と同じにそろえる
 */
const socketOf = (ws: WebSocket): ConnSocket => {
  const close = ws.close.bind(ws);
  ws.close = (code?: number, reason?: string | Buffer) => close(closeBackCode(code), reason);
  return {
    send: (frame) => {
      try {
        ws.send(frame);
      } catch {
        // 閉じかけている。close で出たことになる
      }
    },
    close: (code, reason) => {
      try {
        close(code, reason);
      } catch {
        // もう閉じている
      }
    },
  };
};

/**
 * このインスタンスの部屋。部屋につないできた WebSocket を受け、このインスタンスが部屋の持ち主なら
 * 部屋に渡し、ほかのインスタンスが持ち主なら、そちらへ中継する
 */
export class RoomRuntime {
  /** このインスタンスが持ち主の（持ち主になろうとしている）部屋 */
  private readonly rooms = new Map<string, Promise<Claim>>();
  /** ほかのインスタンスへ中継している WebSocket。接続の ID ごと（持ち主から届いたものを渡す） */
  private readonly proxies = new Map<string, ConnSocket>();
  /** ほかのインスタンスへ中継している WebSocket。部屋ごと（持ち主が替われば、つなぎ直してもらう） */
  private readonly watched = new Map<string, Set<ConnSocket>>();
  /** 持ち主として、ほかのインスタンスからの WebSocket を受けている部屋 */
  private readonly served = new WeakSet<VercelRoom>();
  private readonly parkMs: number;
  private started: Promise<void> | null = null;
  /** 放した部屋の受け口を閉じているところ */
  private readonly unserving = new Set<Promise<void>>();

  constructor(
    private readonly deps: RoomDeps,
    private readonly options: RuntimeOptions,
    private readonly relay?: Relay
  ) {
    this.parkMs = options.parkMs ?? PARK_MS;
  }

  /** 中継を受け始める */
  private ready(): Promise<void> {
    const relay = this.relay;
    if (!relay) return Promise.resolve();
    this.started ??= relay
      .start()
      .then(() => relay.subscribe<Outbound>(relay.outboundOf(relay.instance), (message) => this.fromOwner(message)));
    return this.started;
  }

  /** 部屋の持ち主になろうとする。ほかのインスタンスが持ち主なら、そのインスタンスを返す */
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
    // 待つあいだに放されたら（だれもいなくなった）、もう一度
    return pending.then((claim) => ('room' in claim && claim.room.isReleased ? this.claim(roomKey) : claim));
  }

  /** このインスタンスで部屋を開く。ほかのインスタンスが持ち主なら、放すまで待つ */
  async room(roomKey: string): Promise<VercelRoom> {
    for (;;) {
      const claim = await this.claim(roomKey);
      if ('room' in claim) return claim.room;
      await sleep(RETRY_MS);
    }
  }

  /** このインスタンスが持ち主の（持ち主になろうとしている）部屋。無ければ null */
  async openRoom(roomKey: string): Promise<VercelRoom | null> {
    const claim = await this.rooms.get(roomKey);
    return claim && 'room' in claim ? claim.room : null;
  }

  /** このインスタンスの部屋をすべて放し、中継もやめる */
  async close(): Promise<void> {
    for (const pending of [...this.rooms.values()]) {
      const claim = await pending;
      if ('room' in claim) await claim.room.release();
    }
    await Promise.all(this.unserving);
    await this.relay?.stop();
  }

  /** 部屋の中で run を動かす。だれもつないでいなければ、終わったら放す */
  async withRoom<T>(roomKey: string, run: (room: VercelRoom) => T | Promise<T>): Promise<T> {
    const room = await this.room(roomKey);
    try {
      return await run(room);
    } finally {
      if (room.size === 0) await room.release();
    }
  }

  /**
   * 部屋を削除する。持ち主がこのインスタンスか、だれもいなければここで消す。ほかのインスタンスが持ち主
   * なら、ここで GM かを確かめてから、持ち主に消させる（一覧からはすぐ外す）
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
      // 持ち主が落ちていた。消す印を付けて、掃除に残りを消させる
      await redis
        .multi()
        .hSet(roomKeysOf(key, roomKey).meta, 'deleting', '1')
        .zAdd(expiryKeyOf(key), { score: Date.now(), value: roomKey })
        .exec();
    }
    await lobby.remove(roomKey);
    return 'deleted';
  }

  /** 部屋につないできた WebSocket を受ける */
  attach(ws: WebSocket, roomKey: string): void {
    const conn: Conn = { id: crypto.randomUUID(), socket: socketOf(ws), seat: null };
    const link: Link = { waiting: [], route: null, leave: null, rotated: false, gone: false };

    // Vercel の Function の最大実行時間で切られる前に、こちらから閉じてつなぎ直させる
    const rotation = setTimeout(() => {
      link.rotated = true;
      conn.socket.close(COME_BACK_CODE, 'rotate');
    }, this.options.socketSeconds * 1000);
    rotation.unref();

    ws.on('message', (data, isBinary) => {
      const message = isBinary ? new Uint8Array(data as Buffer) : String(data);
      // PING には、部屋に渡さずに答える（Cloudflare 版では部屋を起こさずに答える）
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

  /** 持ち主を見つけて、WebSocket をつなぐ。このインスタンスが持ち主になれば部屋に、でなければ中継する */
  private async connect(conn: Conn, roomKey: string, link: Link): Promise<void> {
    await this.ready();
    // 持ち主を探すのは lease の2倍の時間まで。持ち主が落ちていても、lease が切れれば持ち主になれる
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

  /** 持ち主へ中継する。持ち主が受けなければ（放したばかり、落ちた）false */
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
    // 持ち主に届かなくなった（落ちた）。つなぎ直してもらう
    const moved = () => conn.socket.close(COME_BACK_CODE, 'moved');
    // 1つの WebSocket から届いたものは、届いた順に送る
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

  /** 持ち主から届いたものを、中継している WebSocket に渡す */
  private fromOwner(message: Outbound): void {
    const socket = this.proxies.get(message.c);
    if (!socket) return;
    if (message.t === 'frame') socket.send(message.d);
    else socket.close(message.code, message.reason);
  }

  /** 中継する WebSocket の部屋の知らせを受ける。持ち主が替われば（放した）、つなぎ直してもらう */
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

  /** 持ち主として、ほかのインスタンスに着いた WebSocket を受ける */
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
        // 届かなくても（そのインスタンスが落ちた）、見回りがその席を外す
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

  /** 持ち主をやめた。ほかのインスタンスに着いた WebSocket には、つなぎ直してもらう */
  private async unserve(room: VercelRoom): Promise<void> {
    const relay = this.relay;
    if (!relay || !this.served.has(room)) return;
    await relay.unsubscribe(relay.inboundOf(room.roomKey));
    await relay.unsubscribe(relay.controlOf(room.roomKey));
    if (room.remotes.length > 0) await relay.publish(relay.controlOf(room.roomKey), { t: 'moved' });
  }
}
