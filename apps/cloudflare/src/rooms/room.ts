import { DurableObject } from 'cloudflare:workers';

import { PING, PONG } from '../../contracts/protocol';
import type { PeerRole } from '../../contracts/protocol';
import { deleteRoomAssets } from '../assets/sweep';
import { parseConfig } from '../config';
import { hashPassword } from '../core/rooms/password';
import { RoomEngine } from '../core/rooms/engine';
import type { RoomInit } from '../core/http/backend';
import type { RoleBook, RoomEvent, RoomFacts, RoomHost, Seat } from '../core/rooms/host';
import { LOBBY_NAME } from './lobby';
import { RoomStore, migrate } from './store';

/** 部屋を消しきれなかったとき、もう一度消しにくるまでの時間（ミリ秒） */
export const WIPE_RETRY_MS = 60_000;

interface RoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  host: string;
  room_id: string;
  name: string;
  password_salt: ArrayBuffer | null;
  password_hash: ArrayBuffer | null;
  /** 最後の1人が出た時刻。だれかいれば null */
  emptied_at: number | null;
}

/**
 * 1つの部屋。部屋にいる人の WebSocket を受け、中継と同期は RoomEngine に任せ、部屋の状態を持つ。
 * 最後の1人が出てから保持期間が過ぎると、部屋ごと消す。
 *
 * Hibernation に入るとメモリは消えるので、接続の情報（席）は WebSocket に添え、状態は SQLite に置く。
 * メモリに置くのは、読み直せるもの（索引）と、消えても困らないもの（送りすぎの数）だけ。
 */
export class RoomDurableObject extends DurableObject<Env> implements RoomHost<WebSocket> {
  private storeCache: RoomStore | null = null;
  private lobbyQueue: Promise<void> = Promise.resolve();
  /**
   * 部屋を消している最中。消すあいだに一覧や R2 を待つので、そのあいだに来たものを受けないための印。
   * 消し終われば部屋の行も無くなるので、メモリだけに置けばよい
   */
  private deleting = false;
  private readonly engine = new RoomEngine<WebSocket>(this);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** 部屋を作る。Worker の POST /v1/rooms から呼ぶ */
  async create(init: RoomInit): Promise<void> {
    const password = init.password ? hashPassword(init.password) : null;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS room (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_key TEXT NOT NULL,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      password_salt BLOB,
      password_hash BLOB,
      host TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      emptied_at INTEGER
    )`);
    // ログインした人ごとの役割。部屋を作った人が GM になる
    sql.exec(`CREATE TABLE IF NOT EXISTS seats (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL
    )`);
    migrate(sql);
    sql.exec(`INSERT INTO seats (user_id, role) VALUES (?, 'gm')`, init.creatorUserId);
    sql.exec(
      `INSERT INTO room
         (id, room_key, room_id, name, password_salt, password_hash, host, created_at, emptied_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      init.roomKey,
      init.roomId,
      init.name,
      password?.salt ?? null,
      password?.hash ?? null,
      init.host,
      Date.now(),
      Date.now(),
    );
    // だれも入らなければ、入った人が出たときと同じく保持期間で消える
    await this.ctx.storage.setAlarm(Date.now() + this.retentionMs());
    await this.lobby().register({
      roomKey: init.roomKey,
      roomId: init.roomId,
      name: init.name,
      hasPassword: password !== null,
      members: 0,
    });
    await this.lobby().setGameMasters(init.roomKey, [init.creatorUserId]);
  }

  /**
   * 部屋を削除する。Worker の DELETE /v1/rooms/:roomKey から呼ぶ。削除できるのはその部屋の GM だけ。
   * 入っている人には room-deleted を送ってから閉じ、保持期間が過ぎたときと同じく、一覧から外して
   * 置いたものをすべて消す
   */
  async deleteRoom(userId: string): Promise<'deleted' | 'not-found' | 'not-game-master'> {
    const room = this.roomRow();
    if (!room || this.deleting) return 'not-found';
    if (this.roles.roleOf(userId) !== 'gm') return 'not-game-master';

    this.record('delete', 'gm', this.engine.seats().length);
    this.engine.closeAll();
    await this.wipe(room.room_key);
    return 'deleted';
  }

  /**
   * アセットを置こうとしている人が、いまもこの部屋で置ける役割（GM か PL）か。アセットの PUT から尋ねる。
   * トークンは15分使えるので、そのあいだに部屋が消えたり、見学に変えられたりしていれば断る
   */
  canUpload(userId: string): 'ok' | 'room-not-found' | 'not-a-player' {
    return this.engine.canUpload(userId);
  }

  /**
   * WebSocket の接続を受ける。Worker が Origin とレート制限を確かめてから回してくる。
   * 部屋が無いときと満員のときも、つないでから理由を送って閉じる
   */
  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.engine.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.engine.receive(ws, message);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.engine.closed(ws);
    // 閉じてきたので、閉じ返して閉じる手順を終える。送れない番号（1005 など）なら 1000 で返す
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
    } catch {
      // もう閉じている
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.engine.closed(ws);
  }

  /**
   * 部屋の時計。人がいれば見回り、一覧の人数を合わせて、また見回る。出ていくのを見届けないまま
   * だれもいなくなっていたら（Worker が落ちたときなど）、そこから保持期間を数え始める。最後の1人が
   * 出てから保持期間が過ぎていれば、部屋を一覧から外し、置いたものをすべて消す
   */
  override async alarm(): Promise<void> {
    // 消しきれなかった部屋を、消しなおす。消している最中なら、終わるのを待って、また来る
    const deleting = this.deletingRoomKey();
    if (deleting !== null && this.deleting) {
      await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
      return;
    }
    if (deleting !== null) return this.wipe(deleting);
    // トークンの切れた席を外す。最後の1人が外れたなら、出ていったときと同じく保持期間の時計が置かれた
    const seated = this.engine.seats().length;
    this.engine.expireSeats();
    if (seated > 0 && this.engine.seats().length === 0) return;
    const room = this.roomRow();
    if (room && this.engine.seats().length > 0) {
      this.engine.dropStrayCursors();
      await this.ctx.storage.setAlarm(this.engine.nextCheckAt());
      this.lobbyChanged(room.room_key);
      return;
    }
    if (room && room.emptied_at === null) {
      this.emptied();
      this.lobbyChanged(room.room_key);
      return;
    }
    await this.wipe(room?.room_key ?? null);
  }

  /**
   * 部屋を一覧から外し、部屋のアセットと置いたものと時計をすべて消す。アセットを消しそこねても、
   * 部屋が一覧に無いので、アップロードのついでの掃除が拾う
   */
  private async wipe(roomKey: string | null): Promise<void> {
    this.deleting = true;
    try {
      if (roomKey) {
        // 消しはじめたことを先に書く。途中で失敗しても、Worker が落ちても、入れる部屋には戻らない。
        // 落ちたときに残りを消しにくる時計も、外へ尋ねる前に置く（もとの時計は保持期間の終わりかもしれない）
        const sql = this.ctx.storage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS deleting (room_key TEXT NOT NULL)');
        sql.exec('DELETE FROM deleting');
        sql.exec('INSERT INTO deleting (room_key) VALUES (?)', roomKey);
        await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
        await this.lobby().remove(roomKey);
        await deleteRoomAssets(this.env.ASSETS, roomKey).catch((err: unknown) =>
          console.error('Room asset deletion failed:', err),
        );
      }
      this.engine.stopFlushing();
      this.storeCache = null;
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    } catch (err) {
      // 一覧から外せなかったなどで、消しきれなかった。時計で、もう一度消しにくる
      console.error('Room deletion failed, to be tried again:', err);
      await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
    } finally {
      this.deleting = false;
    }
  }

  /** 消しはじめて、消しきれていない部屋の鍵。無ければ null */
  private deletingRoomKey(): string | null {
    const sql = this.ctx.storage.sql;
    const exists = sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deleting'")
      .toArray();
    if (exists.length === 0) return null;
    // 消しはじめるときに1行だけ書き、消しおわると表ごと消える
    return sql.exec<{ room_key: string }>('SELECT room_key FROM deleting').one().room_key;
  }

  // ---- RoomEngine に渡すもの ----

  connections(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  seatOf(ws: WebSocket): Seat | null {
    return ws.deserializeAttachment() as Seat | null;
  }

  setSeat(ws: WebSocket, seat: Seat): void {
    ws.serializeAttachment(seat);
  }

  send(ws: WebSocket, frame: Uint8Array): void {
    try {
      ws.send(frame);
    } catch {
      // 閉じかけている。webSocketClose で出たことになる
    }
  }

  close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // もう閉じている
    }
  }

  room(): RoomFacts | null {
    const row = this.roomRow();
    if (!row) return null;
    const { password_salt: salt, password_hash: hash } = row;
    return { roomKey: row.room_key, password: salt && hash ? { salt, hash } : null };
  }

  wiping(): boolean {
    return this.deleting;
  }

  store(): RoomStore {
    this.storeCache ??= new RoomStore(this.ctx.storage);
    return this.storeCache;
  }

  /** ログインした人ごとの役割。seats の表に置く */
  readonly roles: RoleBook = {
    roleOf: (userId) =>
      this.ctx.storage.sql
        .exec<{ role: PeerRole }>('SELECT role FROM seats WHERE user_id = ?', userId)
        .toArray()[0]?.role ?? null,
    add: (userId, role) => {
      this.ctx.storage.sql.exec('INSERT INTO seats (user_id, role) VALUES (?, ?)', userId, role);
    },
    set: (userId, role) => {
      this.ctx.storage.sql.exec('UPDATE seats SET role = ? WHERE user_id = ?', role, userId);
    },
    gameMasterCount: () =>
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM seats WHERE role = 'gm'")
        .one().count,
  };

  /**
   * トークンを確かめる鍵。部屋はログインを置いた Worker でしか作れないが、あとでログインを外すと
   * null になる。そのあいだはトークンを確かめも作りもしない（見学では入れる）
   */
  sessionSecret(): string | null {
    return parseConfig(this.env).login?.sessionSecret ?? null;
  }

  /** 1回の PUT で、種類ごとの上限まで置ける */
  assetUploadPolicy(): null {
    return null;
  }

  /** 人がいるあいだは消さずに見回る */
  occupied(nextCheckAt: number): void {
    this.ctx.storage.sql.exec('UPDATE room SET emptied_at = NULL');
    void this.ctx.storage.setAlarm(nextCheckAt);
  }

  /** だれもいなくなった。ここから保持期間を数える */
  emptied(): void {
    this.ctx.storage.sql.exec('UPDATE room SET emptied_at = ?', Date.now());
    void this.ctx.storage.setAlarm(Date.now() + this.retentionMs());
  }

  /**
   * 一覧の人数と GM を直す。知らせる順に並べ、どちらも知らせるときに数える。
   * それまでに部屋が削除されていれば知らせない
   */
  lobbyChanged(roomKey: string): void {
    this.lobbyQueue = this.lobbyQueue
      .then(async () => {
        if (!this.roomRow()) return;
        const gameMasters = this.ctx.storage.sql
          .exec<{ user_id: string }>("SELECT user_id FROM seats WHERE role = 'gm'")
          .toArray()
          .map((row) => row.user_id);
        await this.lobby().setMembers(roomKey, this.engine.seats().length);
        await this.lobby().setGameMasters(roomKey, gameMasters);
      })
      .catch((err: unknown) => console.error('Lobby update failed:', err));
    this.ctx.waitUntil(this.lobbyQueue);
  }

  /**
   * 部屋で起きたことを Workers Analytics Engine に1点書く。index は部屋の鍵、blob は Worker のホスト名・
   * 出来事・その中身（役割、閉じた理由、ゲームシステム）、double はその量（人数、つないでいた秒、
   * 書いた変更の数、振るのにかかったミリ秒）。部屋が消えたあとなら書かない
   */
  record(event: RoomEvent, detail: string, value: number): void {
    const room = this.roomRow();
    if (!room) return;
    this.env.METRICS.writeDataPoint({
      indexes: [room.room_key],
      blobs: [room.host, event, detail],
      doubles: [value],
    });
  }

  defer(work: Promise<unknown>): void {
    this.ctx.waitUntil(work);
  }

  // ---- 部屋の行 ----

  /** 部屋の行。作られていないか、消えたあとなら null */
  private roomRow(): RoomRow | null {
    const sql = this.ctx.storage.sql;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room', 'deleting')",
      )
      .toArray()
      .map((table) => table.name);
    // 消しはじめた部屋は、消しきれていなくても無いものとして扱う
    if (!tables.includes('room') || tables.includes('deleting')) return null;
    return sql
      .exec<RoomRow>(
        'SELECT room_key, room_id, name, password_salt, password_hash, host, emptied_at FROM room',
      )
      .one();
  }

  private retentionMs(): number {
    return parseConfig(this.env).roomRetentionSeconds * 1000;
  }

  private lobby() {
    return this.env.LOBBY.getByName(LOBBY_NAME);
  }
}
