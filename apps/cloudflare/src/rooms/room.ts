import { DurableObject } from 'cloudflare:workers';
import { safeParse } from 'valibot';

import {
  AUTHORITY_PEER_ID,
  AuthorityEvent,
  CATALOG_BATCH,
  CHAT_MESSAGE_ALIAS,
  CHAT_TAB_ALIAS,
  CLOSE_CODE,
  DICE_BOT_SENDER,
  MAX_MEMBERS,
  PEER_CURSOR_ALIAS,
  PING,
  PONG,
  PROTOCOL_VERSION,
  SERVER_ROLL_FIELD,
  SyncEvent,
  judgeUpdate,
} from '../../contracts/protocol';
import type {
  ErrorCode,
  EventContext,
  ObjectContext,
  PeerRole,
  RoleRejectReason,
  ServerMessage,
} from '../../contracts/protocol';
import { INVITE_SECONDS, readToken, signToken } from '../auth/tokens';
import { parseConfig } from '../config';
import { rollLine } from '../dice/roll';
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
  roleRequestSchema,
  rollRequestSchema,
} from './messages';
import { attributesOf, withAttributes } from './objects';
import { hashPassword, verifyPassword } from './password';
import { RoomStore, migrate } from './store';

/**
 * 変更をまとめて書くまでの間（ミリ秒）。待っているあいだは Hibernation に入らないので、
 * 落ちたときに失うのは最大でこの長さの変更だけ。それも、つなぎ直したときのカタログの交換で戻る
 */
export const FLUSH_DELAY_MS = 1000;

/** 書いた変更の数を、Analytics Engine にまとめて書く間（ミリ秒）。1秒ごとに書くと点が多すぎる */
export const FLUSH_TALLY_MS = 60_000;

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
  /** 部屋を作った人のユーザー ID。この人が GM になる */
  creatorUserId: string;
  /** 受けた Worker のホスト名。同じアカウントに置いた別の Worker と、記録を分けるのに使う */
  host: string;
}

/** Workers Analytics Engine に書く出来事 */
type RoomEvent = 'join' | 'leave' | 'refuse' | 'flush' | 'roll';

/**
 * 接続ごとの情報。WebSocket に添えて置くので、Hibernation から起き直しても残る。
 * hello が通るまでは null
 */
interface Seat {
  peerId: string;
  userId: string;
  /** 部屋の一覧に人数を知らせるときの鍵 */
  roomKey: string;
  /** サーバーが決めた役割 */
  role: PeerRole;
  /** ログインして入った。ログインしていない人は見学のまま、役割を変えられない */
  account: boolean;
  /** 入った時刻（Unix ミリ秒） */
  joinedAt: number;
  /** サーバーが閉じた（断った、または同じピア ID の新しい接続に替わった） */
  closed?: boolean;
}

interface RoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  host: string;
  room_id: string;
  name: string;
  password_salt: ArrayBuffer | null;
  password_hash: ArrayBuffer | null;
}

const seatOf = (ws: WebSocket): Seat | null => ws.deserializeAttachment() as Seat | null;

const memberOf = (seat: Seat) => ({ peerId: seat.peerId, userId: seat.userId, role: seat.role });

const isHello = (value: unknown): value is { protocolVersion?: unknown } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hello';

const fromAuthority = (eventName: string, data: unknown): EventContext => ({
  eventName,
  data,
  sendFrom: AUTHORITY_PEER_ID,
});

type Reply = (eventName: string, data: unknown) => void;

/** サーバーが振った結果の発言で、書き換えさせない attributes（ほかに syncData.value も） */
const ROLLED_ATTRIBUTES = ['dicebot', 'tag', 'name', 'from', 'originFrom', SERVER_ROLL_FIELD];

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
  /** まだ記録していない、書いた変更の数と、数え始めた時刻 */
  private flushTally = { count: 0, since: 0 };
  /** 頼まれた順に振る。システムを初めて読み込むときだけ待つ */
  private rollQueue: Promise<void> = Promise.resolve();
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
      host TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // ログインした人ごとの役割。部屋を作った人が GM になる
    sql.exec(`CREATE TABLE IF NOT EXISTS seats (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL
    )`);
    migrate(sql);
    sql.exec(`INSERT INTO seats (user_id, role) VALUES (?, 'gm')`, init.creatorUserId);
    sql.exec(
      `INSERT INTO room (id, room_key, room_id, name, password_salt, password_hash, host, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      init.roomKey,
      init.roomId,
      init.name,
      password?.salt ?? null,
      password?.hash ?? null,
      init.host,
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
    } else if (received.type === 'invite') {
      this.invite(ws, seat, received.role);
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

    // ログインしていなければ見学。ログインしていれば、トークンの人と userId が同じでなければならない
    const seat: Seat = {
      peerId: hello.peerId,
      userId: hello.userId,
      roomKey: room.room_key,
      role: 'guest',
      account: false,
      joinedAt: Date.now(),
    };
    if (hello.accessToken) {
      const secret = this.sessionSecret();
      const claims = readToken(hello.accessToken, 'access', secret);
      if (!claims || claims.uid !== hello.userId) return this.refuse(ws, 'unauthorized');
      seat.role = this.roleOf(hello.userId, hello.invite ?? null, room.room_key, secret);
      seat.account = true;
    }
    this.seat(ws, seat);
  }

  /**
   * ログインした人の役割。前に入ったことがあればそのときの役割、初めてなら招待の役割、
   * 招待が無いか、この部屋のものでなければ PL
   */
  private roleOf(userId: string, invite: string | null, roomKey: string, secret: string): PeerRole {
    const sql = this.ctx.storage.sql;
    const known = sql
      .exec<{ role: PeerRole }>('SELECT role FROM seats WHERE user_id = ?', userId)
      .toArray()[0];
    if (known) return known.role;
    const invited = invite ? readToken(invite, 'invite', secret) : null;
    const role = invited?.room === roomKey ? invited.role : 'pl';
    sql.exec('INSERT INTO seats (user_id, role) VALUES (?, ?)', userId, role);
    return role;
  }

  /** GM に頼まれて、招待を作る。GM でなければ invite を null にして返す */
  private invite(ws: WebSocket, seat: Seat, role: PeerRole): void {
    if (seat.role !== 'gm') {
      this.post(ws, { type: 'invite', role, invite: null, expiresAt: null });
      return;
    }
    const invite = signToken<'invite'>(
      { aud: 'invite', room: seat.roomKey, role },
      INVITE_SECONDS,
      this.sessionSecret(),
    );
    this.post(ws, { type: 'invite', role, invite, expiresAt: Date.now() + INVITE_SECONDS * 1000 });
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
      role: seat.role,
      members: others.filter((other) => other !== previous).map((other) => memberOf(other.seat)),
      serverTime: Date.now(),
    });
    this.post(ws, { type: 'data', from: AUTHORITY_PEER_ID, events: this.catalogEvents() });
    void this.ctx.storage.deleteAlarm();
    if (previous) return;
    this.broadcast(ws, { type: 'join', member: memberOf(seat) });
    this.notifyLobby(seat.roomKey);
    this.record('join', seat.role, this.seats().length);
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
    this.record('leave', seat.role, (Date.now() - seat.joinedAt) / 1000);
  }

  /** 理由を送ってから閉じる。入っていた人なら、出たことにする */
  private refuse(ws: WebSocket, code: ErrorCode): void {
    const seat = seatOf(ws);
    if (seat && !seat.closed) {
      ws.serializeAttachment({ ...seat, closed: true });
      if (code !== 'replaced') this.leave(seat);
    }
    this.post(ws, { type: 'error', code, protocolVersion: PROTOCOL_VERSION });
    this.record('refuse', code, 1);
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
      const toEveryone = (passed: EventContext = event) => {
        common.push(passed);
        targeted.push(passed);
      };
      const toAddressee = () => (to === undefined ? toEveryone() : targeted.push(event));
      switch (eventName) {
        case SyncEvent.UPDATE: {
          // サーバーが中身を直したら（PeerCursor の役割など）、直した方を配る
          const accepted = this.update(data, seat, reply);
          if (accepted) toEveryone({ ...event, data: accepted });
          break;
        }
        case SyncEvent.DELETE:
          if (this.remove(data, seat, reply)) toEveryone();
          break;
        case SyncEvent.FORGET_DELETED:
          if (this.forget(data, seat)) toEveryone();
          break;
        case AuthorityEvent.ROLE_REQUEST:
          if (forAuthority) this.changeRole(data, seat, reply);
          else toAddressee();
          break;
        case AuthorityEvent.ROLL_REQUEST:
          if (forAuthority) this.requestRoll(data, seat);
          else toAddressee();
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

  /**
   * UPDATE を状態に当てる。ほかの人に配るなら、配る中身を返す。
   *
   * PeerCursor の役割は、その人の席の役割で上書きする。上書きしたら、送り主にも直した方を渡す。
   * 見学者は、自分のカーソルと、見学者も話せるタブへの発言しか書けない。
   */
  private update(data: unknown, seat: Seat, reply: Reply): ObjectContext | null {
    const parsed = safeParse(objectContextSchema, data);
    if (!parsed.success) return null;
    let context = parsed.output;
    const { identifier, aliasName } = context;

    let owner: string | null = null;
    let corrected = false;
    if (aliasName === PEER_CURSOR_ALIAS) {
      owner = String(context.syncData.peerId);
      // 出ていった人のカーソルは置かない。クライアントは leave を受けて自分で片付ける
      const ownerSeat = this.seats().find((other) => other.seat.peerId === owner)?.seat;
      if (!ownerSeat) return null;
      if (seat.role === 'guest' && owner !== seat.peerId)
        return this.refuseWrite(identifier, reply);
      if (context.syncData.role !== ownerSeat.role) {
        context = { ...context, syncData: { ...context.syncData, role: ownerSeat.role } };
        corrected = true;
      }
    } else if (seat.role === 'guest' && !this.guestMayWrite(context, seat)) {
      return this.refuseWrite(identifier, reply);
    }
    if (aliasName === CHAT_MESSAGE_ALIAS) {
      const kept = this.keepRolledFields(context);
      corrected = kept !== context;
      context = kept;
    }

    const verdict = judgeUpdate(
      this.store.entryOf(identifier),
      context,
      owner === null && this.store.isDeleted(identifier),
    );
    switch (verdict) {
      case 'accept':
        this.store.put(context, owner);
        if (corrected) reply(AuthorityEvent.AUTHORITATIVE, context);
        return context;
      case 'stale':
        reply(SyncEvent.UPDATE, this.store.get(identifier));
        return null;
      case 'deleted':
        reply(SyncEvent.DELETE, { aliasName, identifier });
        return null;
      default:
        return null;
    }
  }

  /**
   * 見学者が書いてよいもの。見学者も話せるタブ（guestCanSpeak）への新しい発言と、自分の発言の書き直し。
   * ダイスの結果のように、発言の from が本人でないものもあるので、新しい発言は from を問わない
   */
  private guestMayWrite(context: ObjectContext, seat: Seat): boolean {
    if (context.aliasName !== CHAT_MESSAGE_ALIAS) return false;
    const tab = this.store.get(String(context.syncData.parentIdentifier));
    if (tab?.aliasName !== CHAT_TAB_ALIAS || attributesOf(tab).guestCanSpeak !== true) return false;
    const stored = this.store.get(context.identifier);
    if (stored === null) return true;
    const { from, originFrom } = attributesOf(stored);
    return from === seat.userId || originFrom === seat.userId;
  }

  /**
   * サーバーが振った結果の発言は、結果と名前と送り主を書き換えさせない。サーバーが振っていない発言には、
   * サーバーが振った印を付けさせない。直したら、直した中身を返す（直さなければ受けたまま）
   */
  private keepRolledFields(context: ObjectContext): ObjectContext {
    const stored = this.store.get(context.identifier);
    const attributes = attributesOf(context);
    if (stored === null || attributesOf(stored)[SERVER_ROLL_FIELD] !== true) {
      if (attributes[SERVER_ROLL_FIELD] === undefined) return context;
      return {
        ...context,
        syncData: {
          ...context.syncData,
          attributes: Object.fromEntries(
            Object.entries(attributes).filter(([field]) => field !== SERVER_ROLL_FIELD),
          ),
        },
      };
    }
    const kept = attributesOf(stored);
    const changed =
      context.syncData.value !== stored.syncData.value ||
      ROLLED_ATTRIBUTES.some((field) => attributes[field] !== kept[field]);
    if (!changed) return context;
    return withAttributes(
      { ...context, syncData: { ...context.syncData, value: stored.syncData.value } },
      Object.fromEntries(ROLLED_ATTRIBUTES.map((field) => [field, kept[field]])),
    );
  }

  /**
   * ダイスを振り、結果の発言を作って配る。頼まれた順に振り、システムを初めて使うときだけ読み込みを待つ。
   * コマンドでなければ何もしない。見学者は、自分が発言できるタブでだけ振れる
   */
  private requestRoll(data: unknown, seat: Seat): void {
    const parsed = safeParse(rollRequestSchema, data);
    if (!parsed.success) return;
    const request = parsed.output;
    const { message } = request;
    if (message.aliasName !== CHAT_MESSAGE_ALIAS) return;
    if (seat.role === 'guest' && !this.guestMayWrite(message, seat)) return;

    this.rollQueue = this.rollQueue
      .then(async () => {
        const started = Date.now();
        const rolled = await rollLine(request.gameSystem, request.command);
        this.record('roll', request.gameSystem, Date.now() - started);
        // 振っているあいだに、同じ識別子のものが置かれていたら作らない
        const taken =
          this.store.entryOf(message.identifier) || this.store.isDeleted(message.identifier);
        if (!rolled || taken) return;
        // 文面は syncData.value、そのほかは ChatMessage の SyncVar なので attributes に入れる
        const result = withAttributes(
          {
            ...message,
            syncData: { ...message.syncData, value: `${rolled.text}${request.suffix ?? ''}` },
          },
          {
            dicebot: rolled.dicebot,
            tag: rolled.secret ? 'system secret' : 'system',
            name: rolled.secret
              ? `<Secret-BCDice：${request.speaker}>`
              : `<BCDice：${request.speaker}>`,
            from: DICE_BOT_SENDER,
            originFrom: seat.userId,
            [SERVER_ROLL_FIELD]: true,
          },
        );
        this.store.put(result, null);
        this.scheduleFlush();
        this.broadcast(undefined, {
          type: 'data',
          from: AUTHORITY_PEER_ID,
          events: [fromAuthority(SyncEvent.UPDATE, result)],
        });
      })
      .catch((err: unknown) => console.error('Roll failed:', err));
    this.ctx.waitUntil(this.rollQueue);
  }

  /**
   * 書く権限の無い変更を、送り主の手元で戻させる。サーバーが持っていればその中身に戻し、
   * 消したものなら消させ、どちらでもなければ（新しく作ろうとしたもの）印を残さずに取り下げさせる
   */
  private refuseWrite(identifier: string, reply: Reply): null {
    const stored = this.store.get(identifier);
    if (stored) reply(AuthorityEvent.AUTHORITATIVE, stored);
    else if (this.store.isDeleted(identifier))
      reply(SyncEvent.DELETE, { aliasName: '', identifier });
    else reply(AuthorityEvent.WITHDRAW, { identifier });
    return null;
  }

  /** DELETE を状態に当てる。ほかの人に配るなら true。見学者が消せるのは自分のカーソルだけ */
  private remove(data: unknown, seat: Seat, reply: Reply): boolean {
    const parsed = safeParse(deleteSchema, data);
    if (!parsed.success) return false;
    const { aliasName, identifier } = parsed.output;
    const owner = this.store.entryOf(identifier)?.owner ?? null;
    if (seat.role === 'guest' && owner !== seat.peerId) {
      this.refuseWrite(identifier, reply);
      return false;
    }
    this.store.delete(identifier, aliasName !== PEER_CURSOR_ALIAS && owner === null);
    return true;
  }

  /** 見学者からは受けない */
  private forget(data: unknown, seat: Seat): boolean {
    const parsed = safeParse(forgetSchema, data);
    if (!parsed.success || seat.role === 'guest') return false;
    this.store.forget(parsed.output.identifiers ?? []);
    return true;
  }

  /**
   * GM に頼まれて、部屋にいる人の役割を変える。席の表を直し、その人のカーソルの役割を
   * 書き換えて版を上げ、全員に配る。断るときは、頼んだ人に理由を返す
   */
  private changeRole(data: unknown, seat: Seat, reply: Reply): void {
    const parsed = safeParse(roleRequestSchema, data);
    if (!parsed.success) return;
    const { peerId, role } = parsed.output;
    const reject = (reason: RoleRejectReason) =>
      reply(AuthorityEvent.ROLE_REJECTED, { peerId, role, reason });
    if (seat.role !== 'gm') return reject('not-game-master');
    const target = this.seats().find((other) => other.seat.peerId === peerId)?.seat;
    if (!target) return reject('unknown-peer');
    if (!target.account) return reject('not-logged-in');
    const sql = this.ctx.storage.sql;
    const gameMasters = sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM seats WHERE role = 'gm'")
      .one().count;
    if (target.role === 'gm' && role !== 'gm' && gameMasters <= 1)
      return reject('last-game-master');

    sql.exec('UPDATE seats SET role = ? WHERE user_id = ?', role, target.userId);
    const updates: EventContext[] = [];
    for (const { ws, seat: other } of this.seats()) {
      if (other.userId !== target.userId) continue;
      ws.serializeAttachment({ ...other, role });
      for (const identifier of this.store.ownedBy(other.peerId)) {
        const cursor = this.store.get(identifier) as ObjectContext;
        const changed = {
          ...cursor,
          majorVersion: cursor.majorVersion + 1,
          minorVersion: Math.random(),
          syncData: { ...cursor.syncData, role },
        };
        this.store.put(changed, other.peerId);
        updates.push(fromAuthority(SyncEvent.UPDATE, changed));
      }
    }
    if (updates.length > 0) {
      this.broadcast(undefined, { type: 'data', from: AUTHORITY_PEER_ID, events: updates });
    }
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
      const now = Date.now();
      if (this.flushTally.count === 0) this.flushTally.since = now;
      this.flushTally.count += this.store.flush();
      if (now - this.flushTally.since >= FLUSH_TALLY_MS || this.seats().length === 0) {
        this.record('flush', '', this.flushTally.count);
        this.flushTally = { count: 0, since: now };
      }
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
      .exec<RoomRow>('SELECT room_key, room_id, name, password_salt, password_hash, host FROM room')
      .one();
  }

  /**
   * 部屋で起きたことを Workers Analytics Engine に1点書く。index は部屋の鍵、blob は Worker のホスト名・
   * 出来事・その中身（役割、閉じた理由、ゲームシステム）、double はその量（人数、つないでいた秒、
   * 書いた変更の数、振るのにかかったミリ秒）。部屋が消えたあとなら書かない
   */
  private record(event: RoomEvent, detail: string, value: number): void {
    const room = this.room();
    if (!room) return;
    this.env.METRICS.writeDataPoint({
      indexes: [room.room_key],
      blobs: [room.host, event, detail],
      doubles: [value],
    });
  }

  private retentionMs(): number {
    return parseConfig(this.env).roomRetentionSeconds * 1000;
  }

  /**
   * トークンを確かめる鍵。部屋はログインを置いた Worker でしか作れないが、あとでログインを外すと
   * 空になり、どのトークンも通らなくなる（見学では入れる）
   */
  private sessionSecret(): string {
    return parseConfig(this.env).login?.sessionSecret ?? '';
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
