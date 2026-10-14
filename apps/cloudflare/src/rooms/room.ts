import { DurableObject } from 'cloudflare:workers';
import { safeParse } from 'valibot';

import {
  AUTHORITY_PEER_ID,
  CATALOG_BATCH,
  CLOSE_CODE,
  MAX_MEMBERS,
  PEER_CURSOR_ALIAS,
  PING,
  PONG,
  PROTOCOL_VERSION,
  SyncEvent,
  judgeUpdate,
} from '../../contracts/protocol';
import type { ErrorCode, EventContext, ServerMessage } from '../../contracts/protocol';
import { parseConfig } from '../config';
import { decodeFrame, encodeFrame } from './codec';
import { LOBBY_NAME } from './lobby';
import {
  catalogSchema,
  clientMessageSchema,
  deleteSchema,
  forgetSchema,
  helloSchema,
  objectContextSchema,
  requestSchema,
} from './messages';
import { hashPassword, verifyPassword } from './password';
import { RoomStore, migrate } from './store';

/**
 * 変更をまとめて書くまでの間（ミリ秒）。待っているあいだは Hibernation に入らないので、
 * 落ちたときに失うのは最大でこの長さの変更だけ。それも、つなぎ直したときのカタログの交換で戻る
 */
export const FLUSH_DELAY_MS = 1000;

/** 1つの接続が RATE_WINDOW_MS のあいだに送れるフレームの数。超えたら切る */
export const RATE_WINDOW_MS = 10_000;
export const MAX_FRAMES_PER_WINDOW = 2000;

/** hello の前のものも含めて、1つの部屋が受ける WebSocket の数 */
export const MAX_SOCKETS = MAX_MEMBERS * 2;

/** 部屋を作るときに Worker から渡すもの */
export interface RoomInit {
  roomKey: string;
  roomId: string;
  name: string;
  /** 空ならパスワードの無い部屋 */
  password: string;
}

/**
 * 接続ごとの情報。WebSocket に添えて置くので、Hibernation から起き直しても残る。
 * hello が通るまでは null
 */
interface Seat {
  peerId: string;
  userId: string;
  /** 部屋の一覧に人数を知らせるときの鍵 */
  roomKey: string;
  /** サーバーが閉じた（断った、または同じピア ID の新しい接続に替わった） */
  closed?: boolean;
}

interface RoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  room_id: string;
  name: string;
  password_salt: ArrayBuffer | null;
  password_hash: ArrayBuffer | null;
}

const seatOf = (ws: WebSocket): Seat | null => ws.deserializeAttachment() as Seat | null;

const isHello = (value: unknown): value is { protocolVersion?: unknown } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hello';

const fromAuthority = (eventName: string, data: unknown): EventContext => ({
  eventName,
  data,
  sendFrom: AUTHORITY_PEER_ID,
});

/**
 * 1つの部屋。部屋にいる人の WebSocket を受け、イベントを中継しながら、部屋の状態を持つ。
 *
 * クライアントからは、全部を持っている特別なピア（AUTHORITY_PEER_ID）に見える。カタログの交換は
 * このピアとだけ行い、UPDATE と DELETE はここで LWW に当ててから配る。最後の1人が出てから保持期間が
 * 過ぎると、部屋ごと消す。
 *
 * Hibernation に入るとメモリは消えるので、接続の情報は WebSocket に添え、状態は SQLite に置く。
 * メモリに置くのは、読み直せるもの（索引）と、消えても困らないもの（送りすぎの数）だけ。
 */
export class RoomDurableObject extends DurableObject<Env> {
  private storeCache: RoomStore | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lobbyQueue: Promise<void> = Promise.resolve();
  /** 送ってきたフレームの数。窓の始まりと、そこからの数 */
  private readonly rates = new WeakMap<WebSocket, { start: number; count: number }>();
  /** 切れたと知らされたもの */
  private readonly gone = new WeakSet<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private get store(): RoomStore {
    this.storeCache ??= new RoomStore(this.ctx.storage);
    return this.storeCache;
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
      created_at INTEGER NOT NULL
    )`);
    migrate(sql);
    sql.exec(
      `INSERT INTO room (id, room_key, room_id, name, password_salt, password_hash, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      init.roomKey,
      init.roomId,
      init.name,
      password?.salt ?? null,
      password?.hash ?? null,
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
  }

  /** WebSocket の接続を受ける。Worker が Origin とレート制限を確かめてから回してくる */
  override async fetch(): Promise<Response> {
    if (!this.room()) return Response.json({ error: 'room-not-found' }, { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return Response.json({ error: 'room-full' }, { status: 503 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // PING には自動で答えるので、ここに来るテキストは使わない
    if (typeof message === 'string') return;
    const seat = seatOf(ws);
    if (seat?.closed) return;
    if (!this.withinRate(ws)) return this.refuse(ws, 'too-many-messages');

    let decoded: unknown;
    try {
      decoded = decodeFrame(message);
    } catch {
      return this.refuse(ws, 'bad-message');
    }
    if (!seat) return this.greet(ws, decoded);

    const parsed = safeParse(clientMessageSchema, decoded);
    if (!parsed.success) return this.refuse(ws, 'bad-message');
    const received = parsed.output;
    if (received.type === 'send') {
      this.relay(ws, seat, received.to ?? undefined, received.events);
    } else if (received.type === 'time') {
      this.post(ws, { type: 'time', serverTime: Date.now() });
    }
    // 入ったあとの hello は何もしない
  }

  override webSocketClose(ws: WebSocket): void {
    this.drop(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.drop(ws);
  }

  /** 最後の1人が出てから保持期間が過ぎた。部屋を一覧から外し、置いたものをすべて消す */
  override async alarm(): Promise<void> {
    if (this.seats().length > 0) return;
    const room = this.room();
    if (room) await this.lobby().remove(room.room_key);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.storeCache = null;
    await this.ctx.storage.deleteAll();
  }

  // ---- 入退室 ----

  private greet(ws: WebSocket, decoded: unknown): void {
    if (!isHello(decoded)) return this.refuse(ws, 'hello-required');
    if (decoded.protocolVersion !== PROTOCOL_VERSION) return this.refuse(ws, 'protocol-mismatch');
    const parsed = safeParse(helloSchema, decoded);
    if (!parsed.success) return this.refuse(ws, 'bad-message');
    const hello = parsed.output;

    const room = this.room();
    if (!room) return this.refuse(ws, 'room-not-found');
    if (
      room.password_salt &&
      room.password_hash &&
      !verifyPassword(hello.password ?? '', { salt: room.password_salt, hash: room.password_hash })
    ) {
      return this.refuse(ws, 'wrong-password');
    }
    this.seat(ws, { peerId: hello.peerId, userId: hello.userId, roomKey: room.room_key });
  }

  private seat(ws: WebSocket, seat: Seat): void {
    const others = this.seats(ws);
    const previous = others.find((other) => other.seat.peerId === seat.peerId);
    if (!previous && others.length >= MAX_MEMBERS) return this.refuse(ws, 'room-full');
    // 同じ人がつなぎ直した。古い方は、もう切れているのに残っているもの
    if (previous) this.refuse(previous.ws, 'replaced');

    ws.serializeAttachment(seat);
    this.post(ws, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      peerId: seat.peerId,
      authorityPeerId: AUTHORITY_PEER_ID,
      members: others
        .filter((other) => other !== previous)
        .map((other) => ({ peerId: other.seat.peerId, userId: other.seat.userId })),
      serverTime: Date.now(),
    });
    this.post(ws, { type: 'data', from: AUTHORITY_PEER_ID, events: this.catalogEvents() });
    void this.ctx.storage.deleteAlarm();
    if (previous) return;
    this.broadcast(ws, { type: 'join', member: { peerId: seat.peerId, userId: seat.userId } });
    this.notifyLobby(seat.roomKey);
  }

  private drop(ws: WebSocket): void {
    if (this.gone.has(ws)) return;
    this.gone.add(ws);
    const seat = seatOf(ws);
    if (seat && !seat.closed) this.leave(seat);
  }

  /** その人が出た。その人のあいだだけ置いていたものを消し、ほかの人に知らせる */
  private leave(seat: Seat): void {
    if (this.store.removeOwnedBy(seat.peerId).length > 0) this.scheduleFlush();
    this.broadcast(undefined, { type: 'leave', peerId: seat.peerId });
    if (this.seats().length === 0) {
      void this.ctx.storage.setAlarm(Date.now() + this.retentionMs());
    }
    this.notifyLobby(seat.roomKey);
  }

  /** 理由を送ってから閉じる。入っていた人なら、出たことにする */
  private refuse(ws: WebSocket, code: ErrorCode): void {
    const seat = seatOf(ws);
    if (seat && !seat.closed) {
      ws.serializeAttachment({ ...seat, closed: true });
      if (code !== 'replaced') this.leave(seat);
    }
    this.post(ws, { type: 'error', code, protocolVersion: PROTOCOL_VERSION });
    try {
      ws.close(CLOSE_CODE, code);
    } catch {
      // もう閉じている
    }
  }

  /** 入っている人。exclude を除く */
  private seats(exclude?: WebSocket): { ws: WebSocket; seat: Seat }[] {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const seat = seatOf(ws);
      return ws !== exclude && seat && !seat.closed && !this.gone.has(ws) ? [{ ws, seat }] : [];
    });
  }

  private withinRate(ws: WebSocket): boolean {
    const now = Date.now();
    const rate = this.rates.get(ws);
    if (!rate || now - rate.start >= RATE_WINDOW_MS) {
      this.rates.set(ws, { start: now, count: 1 });
      return true;
    }
    rate.count += 1;
    return rate.count <= MAX_FRAMES_PER_WINDOW;
  }

  // ---- 中継と同期 ----

  /**
   * 送られてきたイベントを、読むものは読んでから宛先へ届ける。送り主には返さない。
   *
   * 受け取る人ごとに、送られてきた順のまま並べる。宛先の無いものはほかの全員へ、宛先のあるものは
   * その人だけへ。ただし UPDATE と DELETE は、サーバーの状態を変えたら宛先にかかわらず全員へ配る。
   * サーバーからの答え（古い版への送り返しや、カタログへの返事）は、送り主にだけ返す。
   */
  private relay(
    sender: WebSocket,
    seat: Seat,
    to: string | undefined,
    events: { eventName: string; data: unknown }[],
  ): void {
    const others = this.seats(sender);
    const target = to === undefined ? undefined : others.find((other) => other.seat.peerId === to);
    const forAuthority = to === undefined || to === AUTHORITY_PEER_ID;
    /** 宛先のある送り先を除いた、ほかの全員に届けるもの */
    const common: EventContext[] = [];
    /** 宛先の人に届けるもの */
    const targeted: EventContext[] = [];
    const replies: EventContext[] = [];
    const reply = (eventName: string, data: unknown) =>
      replies.push(fromAuthority(eventName, data));

    for (const { eventName, data } of events) {
      const event: EventContext = { eventName, data, sendFrom: seat.peerId };
      const toEveryone = () => {
        common.push(event);
        targeted.push(event);
      };
      const toAddressee = () => (to === undefined ? toEveryone() : targeted.push(event));
      switch (eventName) {
        case SyncEvent.UPDATE:
          if (this.update(data, reply)) toEveryone();
          break;
        case SyncEvent.DELETE:
          if (this.remove(data)) toEveryone();
          break;
        case SyncEvent.FORGET_DELETED:
          if (this.forget(data)) toEveryone();
          break;
        case SyncEvent.CATALOG:
          if (forAuthority) this.answerCatalog(data, reply);
          else toAddressee();
          break;
        case SyncEvent.REQUEST:
          if (forAuthority) this.answerRequest(data, reply);
          else toAddressee();
          break;
        case SyncEvent.REQUEST_CATALOG:
          if (forAuthority) replies.push(...this.catalogEvents());
          else toAddressee();
          break;
        default:
          toAddressee();
      }
    }

    if (common.length > 0) {
      const frame = encodeFrame({ type: 'data', from: seat.peerId, events: common });
      for (const other of others) if (other !== target) this.sendFrame(other.ws, frame);
    }
    if (target && targeted.length > 0) {
      this.post(target.ws, { type: 'data', from: seat.peerId, events: targeted });
    }
    if (replies.length > 0)
      this.post(sender, { type: 'data', from: AUTHORITY_PEER_ID, events: replies });
    if (this.store.hasPending) this.scheduleFlush();
  }

  /** UPDATE を状態に当てる。ほかの人に配るなら true */
  private update(data: unknown, reply: (eventName: string, data: unknown) => void): boolean {
    const parsed = safeParse(objectContextSchema, data);
    if (!parsed.success) return false;
    const context = parsed.output;
    const { identifier, aliasName } = context;

    let owner: string | null = null;
    if (aliasName === PEER_CURSOR_ALIAS) {
      owner = String(context.syncData.peerId);
      // 出ていった人のカーソルは置かない。クライアントは leave を受けて自分で片付ける
      if (!this.seats().some(({ seat }) => seat.peerId === owner)) return false;
    }

    const verdict = judgeUpdate(
      this.store.entryOf(identifier),
      context,
      owner === null && this.store.isDeleted(identifier),
    );
    switch (verdict) {
      case 'accept':
        this.store.put(context, owner);
        return true;
      case 'stale':
        reply(SyncEvent.UPDATE, this.store.get(identifier));
        return false;
      case 'deleted':
        reply(SyncEvent.DELETE, { aliasName, identifier });
        return false;
      default:
        return false;
    }
  }

  /** DELETE を状態に当てる。ほかの人に配るなら true */
  private remove(data: unknown): boolean {
    const parsed = safeParse(deleteSchema, data);
    if (!parsed.success) return false;
    const { aliasName, identifier } = parsed.output;
    const isCursor =
      aliasName === PEER_CURSOR_ALIAS || (this.store.entryOf(identifier)?.owner ?? null) !== null;
    this.store.delete(identifier, !isCursor);
    return true;
  }

  private forget(data: unknown): boolean {
    const parsed = safeParse(forgetSchema, data);
    if (!parsed.success) return false;
    this.store.forget(parsed.output.identifiers ?? []);
    return true;
  }

  /**
   * クライアントのカタログに答える。サーバーが持っていないか古いものは送ってもらい、
   * 消したものは消させる。サーバーの方が新しいものは、クライアントがサーバーのカタログを見て取りに来る
   */
  private answerCatalog(data: unknown, reply: (eventName: string, data: unknown) => void): void {
    const parsed = safeParse(catalogSchema, data);
    if (!parsed.success) return;
    for (const { identifier, version } of parsed.output) {
      if (this.store.isDeleted(identifier)) {
        reply(SyncEvent.DELETE, { aliasName: '', identifier });
        continue;
      }
      const stored = this.store.entryOf(identifier);
      if (!stored || stored.majorVersion + stored.minorVersion < version) {
        reply(SyncEvent.REQUEST, identifier);
      }
    }
  }

  private answerRequest(data: unknown, reply: (eventName: string, data: unknown) => void): void {
    const parsed = safeParse(requestSchema, data);
    if (!parsed.success) return;
    const identifier = parsed.output;
    if (this.store.isDeleted(identifier)) {
      reply(SyncEvent.DELETE, { aliasName: '', identifier });
      return;
    }
    const context = this.store.get(identifier);
    if (context) reply(SyncEvent.UPDATE, context);
  }

  /** サーバーのカタログ。空でも1件は送り、カタログを送り終えたことがわかるようにする */
  private catalogEvents(): EventContext[] {
    const catalog = this.store.catalog();
    const events = [fromAuthority(SyncEvent.CATALOG, catalog.slice(0, CATALOG_BATCH))];
    for (let start = CATALOG_BATCH; start < catalog.length; start += CATALOG_BATCH) {
      events.push(fromAuthority(SyncEvent.CATALOG, catalog.slice(start, start + CATALOG_BATCH)));
    }
    return events;
  }

  // ---- 送る ----

  private post(ws: WebSocket, message: ServerMessage): void {
    this.sendFrame(ws, encodeFrame(message));
  }

  private broadcast(exclude: WebSocket | undefined, message: ServerMessage): void {
    const frame = encodeFrame(message);
    for (const { ws } of this.seats(exclude)) this.sendFrame(ws, frame);
  }

  private sendFrame(ws: WebSocket, frame: Uint8Array): void {
    try {
      ws.send(frame);
    } catch {
      // 閉じかけている。webSocketClose で出たことになる
    }
  }

  // ---- 置き場所 ----

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.store.flush();
    }, FLUSH_DELAY_MS);
  }

  /** 部屋の行。作られていないか、消えたあとなら null */
  private room(): RoomRow | null {
    const sql = this.ctx.storage.sql;
    const exists = sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'")
      .toArray();
    if (exists.length === 0) return null;
    return sql
      .exec<RoomRow>('SELECT room_key, room_id, name, password_salt, password_hash FROM room')
      .one();
  }

  private retentionMs(): number {
    return parseConfig(this.env).roomRetentionSeconds * 1000;
  }

  private lobby() {
    return this.env.LOBBY.getByName(LOBBY_NAME);
  }

  /** 一覧の人数を直す。知らせる順に並べ、人数は知らせるときに数える */
  private notifyLobby(roomKey: string): void {
    this.lobbyQueue = this.lobbyQueue
      .then(() => this.lobby().setMembers(roomKey, this.seats().length))
      .catch((err: unknown) => console.error('Lobby update failed:', err));
    this.ctx.waitUntil(this.lobbyQueue);
  }
}
