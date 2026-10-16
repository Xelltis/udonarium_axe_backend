import type { WebSocket } from 'ws';

import { PING, PONG } from '../../../contracts/protocol.js';
import { VercelRoom } from './room.js';
import type { Conn, ConnSocket, RoomDeps } from './room.js';

/**
 * こちらから閉じてつなぎ直させた（rotate）席を、残しておく時間（ミリ秒）。そのあいだに同じ人が
 * つなぎ直せば、ほかの人には出入りを見せずに席を替える
 */
export const PARK_MS = 15_000;

/** こちらから閉じてつなぎ直させるときのコード（Service Restart）。Axe は少し待ってつなぎ直す */
export const ROTATE_CODE = 1012;

export interface RuntimeOptions {
  /** 部屋の WebSocket を、こちらから閉じてつなぎ直させるまでの秒数 */
  socketSeconds: number;
  parkMs?: number;
}

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
 * このインスタンスで開いている部屋。部屋につないできた WebSocket を受け、部屋に渡す
 */
export class RoomRuntime {
  private readonly rooms = new Map<string, Promise<VercelRoom>>();
  private readonly parkMs: number;

  constructor(
    private readonly deps: RoomDeps,
    private readonly options: RuntimeOptions,
  ) {
    this.parkMs = options.parkMs ?? PARK_MS;
  }

  /** 開いている部屋。開いていなければ開く */
  async room(roomKey: string): Promise<VercelRoom> {
    for (;;) {
      let pending = this.rooms.get(roomKey);
      if (!pending) {
        pending = VercelRoom.open(this.deps, roomKey);
        const opening = pending;
        this.rooms.set(roomKey, opening);
        opening.then(
          (room) => {
            room.onRelease = () => {
              if (this.rooms.get(roomKey) === opening) this.rooms.delete(roomKey);
            };
          },
          () => this.rooms.delete(roomKey),
        );
      }
      const room = await pending;
      // 開くあいだに放されたら（だれもいなくなった）、開き直す
      if (!room.isReleased) return room;
    }
  }

  /** このインスタンスで開いている（開きかけの）部屋。開いていなければ null */
  openRoom(roomKey: string): Promise<VercelRoom> | null {
    return this.rooms.get(roomKey) ?? null;
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

  /** 部屋につないできた WebSocket を受ける */
  attach(ws: WebSocket, roomKey: string): void {
    const conn: Conn = { id: crypto.randomUUID(), socket: socketOf(ws), seat: null };
    const waiting: (string | Uint8Array)[] = [];
    let room: VercelRoom | null = null;
    let rotated = false;
    let gone = false;

    const leave = (target: VercelRoom) => {
      if (rotated) setTimeout(() => target.closed(conn), this.parkMs).unref();
      else target.closed(conn);
    };

    // Vercel の Function の最大実行時間で切られる前に、こちらから閉じてつなぎ直させる
    const rotation = setTimeout(() => {
      rotated = true;
      conn.socket.close(ROTATE_CODE, 'rotate');
    }, this.options.socketSeconds * 1000);
    rotation.unref();

    ws.on('message', (data, isBinary) => {
      const message = isBinary ? new Uint8Array(data as Buffer) : String(data);
      // PING には、部屋に渡さずに答える（Cloudflare 版では部屋を起こさずに答える）
      if (message === PING) return conn.socket.send(PONG);
      if (room) room.receive(conn, message);
      else waiting.push(message);
    });
    ws.on('close', () => {
      clearTimeout(rotation);
      gone = true;
      if (room) leave(room);
    });
    ws.on('error', (err) => console.error('Room socket error:', err));

    this.room(roomKey).then(
      (opened) => {
        room = opened;
        opened.accept(conn);
        for (const message of waiting.splice(0)) opened.receive(conn, message);
        if (gone) leave(opened);
      },
      (err: unknown) => {
        console.error('Could not open the room:', err);
        conn.socket.close(1011, 'unavailable');
      },
    );
  }
}
