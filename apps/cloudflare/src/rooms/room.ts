import { DurableObject } from 'cloudflare:workers';
import { safeParse } from 'valibot';

import {
  ACCOUNT_USER_ID_PREFIX,
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
import { deleteRoomAssets } from '../assets/sweep';
import { ASSET_TOKEN_SECONDS, INVITE_SECONDS, readToken, signToken } from '../auth/tokens';
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
import type { StoredEntry } from './store';
import {
  delivered,
  describe,
  looser,
  maskedMinor,
  seesDisclosed,
  unmasked,
  viewFor,
  viewKind,
} from './visibility';
import type { Lookup, View, ViewKind, Viewer } from './visibility';

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

/**
 * 人がいるあいだ、部屋を見回る間（ミリ秒）。Worker が落ちて接続が切れたときは、出ていく知らせが
 * 来ないので、見回りで本当につながっている人を数え直し、一覧の人数を合わせ、だれもいなければ
 * 消す時計を進め始める
 */
export const OCCUPIED_CHECK_MS = 60 * 60 * 1000;

/** hello の前のものも含めて、1つの部屋が受ける WebSocket の数 */
export const MAX_SOCKETS = MAX_MEMBERS * 2;

/** つないでから hello を送るまでに待つ時間（ミリ秒）。過ぎたものは、新しい接続が来たときに閉じる */
export const HELLO_TIMEOUT_MS = 10_000;

/** 1つの接続が RATE_WINDOW_MS のあいだに送れるイベントの数。1つのフレームに多くのイベントを詰めても数える */
export const MAX_EVENTS_PER_WINDOW = 20_000;

/** 1つの接続が RATE_WINDOW_MS のあいだに頼めるダイスの数。超えたものは振らない */
export const MAX_ROLLS_PER_WINDOW = 20;

/** 部屋全体で振るのを待てるダイスの数。超えたものは振らない */
export const MAX_PENDING_ROLLS = 64;

/** 1つの部屋に置けるオブジェクトの数。超える新しいものは受けない */
export const MAX_OBJECTS = 200_000;

/** 見え方の手がかり（親の識別子と、宛先などの中身）の大きさの上限。超えるものは受けない */
export const MAX_VIEW_BYTES = 16 * 1024;

/** アクセストークンが切れてから、つながっている席を外すまでに待つ時間（ミリ秒）。新しいトークンが届くまでの余裕 */
export const TOKEN_GRACE_MS = 60_000;

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
type RoomEvent = 'join' | 'leave' | 'refuse' | 'flush' | 'roll' | 'delete';

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
  /** ログインして入った人の、アクセストークンが切れる時刻（Unix ミリ秒）。新しいトークンが届けば延びる */
  expiresAt?: number;
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
  /** 最後の1人が出た時刻。だれかいれば null */
  emptied_at: number | null;
}

const seatOf = (ws: WebSocket): Seat | null => ws.deserializeAttachment() as Seat | null;

const memberOf = (seat: Seat) => ({ peerId: seat.peerId, userId: seat.userId, role: seat.role });

/**
 * 同じ人の席か。ピア ID が同じでも、ユーザー ID とログインの有無まで同じでなければ別人とみなす。
 * ログインした人のユーザー ID はトークンで確かめてあるので、ほかの人には名乗れない
 */
const isSamePerson = (a: Seat, b: Seat): boolean =>
  a.userId === b.userId && a.account === b.account;

const isHello = (value: unknown): value is { protocolVersion?: unknown } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hello';

const fromAuthority = (eventName: string, data: unknown): EventContext => ({
  eventName,
  data,
  sendFrom: AUTHORITY_PEER_ID,
});

type Reply = (eventName: string, data: unknown) => void;

/** 受け取る人ごとの束に、イベントを1つ足す */
type Push = (ws: WebSocket, event: EventContext) => void;

/** シークレットの tag から secret の語を外したものか。Axe の公開（discloseMessage）が書き換える形 */
const isDisclosureOf = (secretTag: unknown, tag: unknown): boolean => {
  const words = String(secretTag).trim().split(/\s+/);
  return words.includes('secret') && tag === words.filter((word) => word !== 'secret').join(' ');
};

/** 見え方の手がかりが、索引と SQLite の1行に置ける大きさか */
const fitsIndex = (context: ObjectContext): boolean => {
  const { parent, view } = describe(context);
  return parent.length <= 256 && JSON.stringify(view).length <= MAX_VIEW_BYTES;
};

/**
 * GM でない人が、見え方を決めるところをそう変えてよいか。Axe の画面が許すことだけを許す。
 *
 * - メモの公開の範囲は、持ち主だけが変えられる。持ち主は、持ち主か、持ち主のいないものを自分にする人が変えられる。
 *   持ち主のいないメモを自分のものにできるのは、いまそのメモが見える人だけ（GM だけのメモは取れない）
 * - ダイスの持ち主も同じ
 * - カードの持ち主（覗いている人）は、自分にするか、空にするだけ。ほかの人の手札のカードは、向きも
 *   持ち主も場所も変えられない
 * - 発言の宛先と、シークレットを外すことは、送り主だけ（ダイスの結果は振った人）。送り主はだれも変えられない
 */
const mayChangeView = (before: View | null, after: View | null, seat: Seat): boolean => {
  if (!before || !after || before.kind !== after.kind) return true;
  const ownerMove = (from: string, to: string) =>
    from === to || from === seat.userId || (from === '' && to === seat.userId);
  switch (before.kind) {
    case 'note': {
      const next = after as typeof before;
      const disclosureSame =
        before.mode === next.mode && JSON.stringify(before.users) === JSON.stringify(next.users);
      const claimsUnseen =
        before.owner === '' && next.owner === seat.userId && !seesDisclosed(before, seat);
      return (
        (disclosureSame || before.owner === seat.userId) &&
        ownerMove(before.owner, next.owner) &&
        !claimsUnseen
      );
    }
    case 'die':
      return ownerMove(before.owner, (after as typeof before).owner);
    case 'card': {
      const next = after as typeof before;
      if (before.hand !== '' && before.hand !== seat.userId) {
        return JSON.stringify(next) === JSON.stringify(before);
      }
      return next.owner === before.owner || next.owner === '' || next.owner === seat.userId;
    }
    case 'chat': {
      const next = after as typeof before;
      if (next.from !== before.from || next.originFrom !== before.originFrom) return false;
      const sender = before.from === seat.userId || before.originFrom === seat.userId;
      const toSame = JSON.stringify(before.to) === JSON.stringify(next.to);
      return (toSame && (next.secret || !before.secret)) || sender;
    }
    default:
      return true;
  }
};

/** 人の名乗れないユーザー ID。Axe が発言の送り主に使う名前 */
const RESERVED_USER_IDS: ReadonlySet<string> = new Set([DICE_BOT_SENDER, 'System']);

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
  /** 送ってきたフレーム・イベント・ダイスの数。窓の始まりと、そこからの数 */
  private readonly rates = new WeakMap<
    WebSocket,
    { start: number; count: number; events: number; rolls: number }
  >();
  /** 切れたと知らされたもの */
  private readonly gone = new WeakSet<WebSocket>();
  /** 断って閉じたもの。hello の前に断ったものは席が無いので、ここで覚える */
  private readonly refused = new WeakSet<WebSocket>();
  /** hello の前の接続を受けた時刻。Hibernation で消えたら、待ちすぎたものとみなす */
  private readonly connectedAt = new WeakMap<WebSocket, number>();
  /** 振るのを待っているダイスの数 */
  private pendingRolls = 0;

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
    const room = this.room();
    if (!room) return 'not-found';
    const known = this.ctx.storage.sql
      .exec<{ role: PeerRole }>('SELECT role FROM seats WHERE user_id = ?', userId)
      .toArray()[0];
    if (known?.role !== 'gm') return 'not-game-master';

    this.record('delete', 'gm', this.seats().length);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.gone.has(ws) || this.refused.has(ws)) continue;
      this.refused.add(ws);
      // 出たことにはしない（知らせる相手も、書き残す部屋も無くなる）
      const seat = seatOf(ws);
      if (seat) ws.serializeAttachment({ ...seat, closed: true });
      this.post(ws, { type: 'error', code: 'room-deleted', protocolVersion: PROTOCOL_VERSION });
      try {
        ws.close(CLOSE_CODE, 'room-deleted');
      } catch {
        // もう閉じている
      }
    }
    await this.wipe(room.room_key);
    return 'deleted';
  }

  /** WebSocket の接続を受ける。Worker が Origin とレート制限を確かめてから回してくる */
  override async fetch(): Promise<Response> {
    if (!this.room()) return Response.json({ error: 'room-not-found' }, { status: 404 });
    this.closeSilentSockets();
    const open = this.ctx
      .getWebSockets()
      .filter((ws) => !this.gone.has(ws) && !this.refused.has(ws));
    if (open.length >= MAX_SOCKETS) {
      return Response.json({ error: 'room-full' }, { status: 503 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.connectedAt.set(server, Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * hello を送らないまま HELLO_TIMEOUT_MS を過ぎた接続を閉じる。閉じないと、hello を送らない接続で
   * 部屋を満員にできてしまう
   */
  private closeSilentSockets(): void {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (seatOf(ws) || this.gone.has(ws) || this.refused.has(ws)) continue;
      const at = this.connectedAt.get(ws);
      if (at === undefined || now - at > HELLO_TIMEOUT_MS) this.refuse(ws, 'hello-required');
    }
  }

  /**
   * アクセストークンが切れてから TOKEN_GRACE_MS を過ぎても新しいトークンが届かない席を外す。
   * ログアウトしたり、アカウントを消したりした人が、つながったまま見続けないように
   */
  private expireSeats(): void {
    const now = Date.now();
    for (const { ws, seat } of this.seats()) {
      if (seat.expiresAt !== undefined && now > seat.expiresAt + TOKEN_GRACE_MS) {
        this.refuse(ws, 'unauthorized');
      }
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // PING には自動で答えるので、ここに来るテキストは使わない
    if (typeof message === 'string') return;
    this.expireSeats();
    const seat = seatOf(ws);
    if (seat?.closed || this.refused.has(ws)) return;
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
      if (!this.withinEvents(ws, received.events.length))
        return this.refuse(ws, 'too-many-messages');
      this.relay(ws, seat, received.to ?? undefined, received.events);
    } else if (received.type === 'time') {
      this.post(ws, { type: 'time', serverTime: Date.now() });
    } else if (received.type === 'invite') {
      this.invite(ws, seat, received.role);
    } else if (received.type === 'auth') {
      this.renew(ws, seat, received.accessToken);
    } else if (received.type === 'asset-token') {
      this.post(ws, { type: 'asset-token', ...this.assetTokenFor(seat, 'expiresAt') });
    }
    // 入ったあとの hello は何もしない
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.drop(ws);
    // 閉じてきたので、閉じ返して閉じる手順を終える。送れない番号（1005 など）なら 1000 で返す
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
    } catch {
      // もう閉じている
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.drop(ws);
  }

  /**
   * 部屋の時計。人がいれば見回り、一覧の人数を合わせて、また見回る。出ていくのを見届けないまま
   * だれもいなくなっていたら（Worker が落ちたときなど）、そこから保持期間を数え始める。最後の1人が
   * 出てから保持期間が過ぎていれば、部屋を一覧から外し、置いたものをすべて消す
   */
  override async alarm(): Promise<void> {
    const room = this.room();
    if (room && this.seats().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + OCCUPIED_CHECK_MS);
      this.notifyLobby(room.room_key);
      return;
    }
    if (room && room.emptied_at === null) {
      this.markEmptied();
      this.notifyLobby(room.room_key);
      return;
    }
    await this.wipe(room?.room_key ?? null);
  }

  /**
   * 部屋を一覧から外し、部屋のアセットと置いたものと時計をすべて消す。アセットを消しそこねても、
   * 部屋が一覧に無いので、アップロードのついでの掃除が拾う
   */
  private async wipe(roomKey: string | null): Promise<void> {
    if (roomKey) {
      await this.lobby().remove(roomKey);
      await deleteRoomAssets(this.env.ASSETS, roomKey).catch((err: unknown) =>
        console.error('Room asset deletion failed:', err),
      );
    }
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.storeCache = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
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
    if (!hello.accessToken && hello.userId.startsWith(ACCOUNT_USER_ID_PREFIX)) {
      // ログインした人のユーザー ID は、トークン無しには名乗らせない（その人に見えるものが見えてしまう）
      return this.refuse(ws, 'unauthorized');
    }
    // 発言の送り主に使う名前（ダイスボットなど）は名乗らせない。サーバーが振った発言の送り主と
    // みなされ、シークレットや秘話が見えてしまう
    if (RESERVED_USER_IDS.has(hello.userId)) return this.refuse(ws, 'bad-message');
    if (hello.accessToken) {
      const secret = this.sessionSecret();
      const claims = secret ? readToken(hello.accessToken, 'access', secret) : null;
      if (!secret || !claims || claims.uid !== hello.userId) return this.refuse(ws, 'unauthorized');
      seat.role = this.roleOf(hello.userId, hello.invite ?? null, room.room_key, secret);
      seat.account = true;
      seat.expiresAt = claims.exp * 1000;
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

  /**
   * この部屋のアセットを読み書きするトークンと、それが切れる時刻（Unix ミリ秒）。時刻は expiresAt の名前で
   * 返す（welcome と asset-token で名前が違う）。役割を入れておき、置けるのは GM と PL だけにする
   */
  private assetTokenFor<K extends string>(
    seat: Seat,
    expiresAt: K,
  ): { assetToken: string } & Record<K, number> {
    const secret = this.sessionSecret();
    // ログインを外した Worker では、アセットの経路もトークンを受けないので、空にしておく
    if (!secret)
      return { assetToken: '', [expiresAt]: 0 } as { assetToken: string } & Record<K, number>;
    const assetToken = signToken<'asset'>(
      { aud: 'asset', room: seat.roomKey, role: seat.role },
      ASSET_TOKEN_SECONDS,
      secret,
    );
    return { assetToken, [expiresAt]: Date.now() + ASSET_TOKEN_SECONDS * 1000 } as {
      assetToken: string;
    } & Record<K, number>;
  }

  /** GM に頼まれて、招待を作る。GM でないか、ログインを外した Worker なら invite を null にして返す */
  private invite(ws: WebSocket, seat: Seat, role: PeerRole): void {
    const secret = this.sessionSecret();
    if (seat.role !== 'gm' || !secret) {
      this.post(ws, { type: 'invite', role, invite: null, expiresAt: null });
      return;
    }
    const invite = signToken<'invite'>(
      { aud: 'invite', room: seat.roomKey, role },
      INVITE_SECONDS,
      secret,
    );
    this.post(ws, { type: 'invite', role, invite, expiresAt: Date.now() + INVITE_SECONDS * 1000 });
  }

  /**
   * つながったまま、新しいアクセストークンを受ける。同じ人のものなら席の期限を延ばし、そうでなければ
   * 外す。見学の席には期限が無いので、受けても何もしない
   */
  private renew(ws: WebSocket, seat: Seat, accessToken: string): void {
    if (!seat.account) return;
    const claims = readToken(accessToken, 'access', this.sessionSecret() ?? '');
    if (!claims || claims.uid !== seat.userId) return this.refuse(ws, 'unauthorized');
    ws.serializeAttachment({ ...seat, expiresAt: claims.exp * 1000 });
  }

  private seat(ws: WebSocket, seat: Seat): void {
    const others = this.seats(ws);
    const previous = others.find((other) => other.seat.peerId === seat.peerId);
    // ほかの人のピア ID を名乗るものは入れない。入れると、その人を追い出して成り代われてしまう
    if (previous && !isSamePerson(previous.seat, seat)) return this.refuse(ws, 'bad-message');
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
      ...this.assetTokenFor(seat, 'assetTokenExpiresAt'),
    });
    this.post(ws, { type: 'data', from: AUTHORITY_PEER_ID, events: this.catalogEvents(seat) });
    // 人がいるあいだは消さずに見回る
    this.ctx.storage.sql.exec('UPDATE room SET emptied_at = NULL');
    void this.ctx.storage.setAlarm(Date.now() + OCCUPIED_CHECK_MS);
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
    if (this.seats().length === 0) this.markEmptied();
    this.notifyLobby(seat.roomKey);
    this.record('leave', seat.role, (Date.now() - seat.joinedAt) / 1000);
  }

  /** 理由を送ってから閉じる。入っていた人なら、出たことにする */
  private refuse(ws: WebSocket, code: ErrorCode): void {
    const seat = seatOf(ws);
    this.refused.add(ws);
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

  private rateOf(ws: WebSocket): { start: number; count: number; events: number; rolls: number } {
    const now = Date.now();
    let rate = this.rates.get(ws);
    if (!rate || now - rate.start >= RATE_WINDOW_MS) {
      rate = { start: now, count: 0, events: 0, rolls: 0 };
      this.rates.set(ws, rate);
    }
    return rate;
  }

  private withinRate(ws: WebSocket): boolean {
    const rate = this.rateOf(ws);
    rate.count += 1;
    return rate.count <= MAX_FRAMES_PER_WINDOW;
  }

  /** 送ってきたイベントの数が上限のうちか。1つのフレームに詰めたものも1つずつ数える */
  private withinEvents(ws: WebSocket, count: number): boolean {
    const rate = this.rateOf(ws);
    rate.events += count;
    return rate.events <= MAX_EVENTS_PER_WINDOW;
  }

  /** ダイスを頼める数のうちか */
  private withinRolls(ws: WebSocket): boolean {
    const rate = this.rateOf(ws);
    rate.rolls += 1;
    return rate.rolls <= MAX_ROLLS_PER_WINDOW;
  }

  // ---- 中継と同期 ----

  /** その人から見た、そのオブジェクトの見え方 */
  private kindOf(identifier: string, seat: Seat, lookup: Lookup = this.store.lookup): ViewKind {
    return viewKind(identifier, seat, lookup);
  }

  /** その人に見せる形。見せないなら null */
  private viewOf(identifier: string, seat: Seat): ObjectContext | null {
    const context = this.store.get(identifier);
    return context && viewFor(context, this.kindOf(identifier, seat));
  }

  /**
   * 送られてきたイベントを、読むものは読んでから宛先へ届ける。送り主には返さない。
   *
   * 受け取る人ごとに、送られてきた順のまま並べる。宛先の無いものはほかの全員へ、宛先のあるものは
   * その人だけへ。UPDATE と DELETE は、サーバーの状態を変えたら宛先にかかわらず、見てよい人へ
   * 見てよい形で配る。サーバーが差し込むもの（見え方が変わったものの出し入れ、古い版への送り返し、
   * カタログへの返事）は sendFrom を AUTHORITY_PEER_ID にして、同じ束に入れる。
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
    const outbox = new Map<WebSocket, EventContext[]>();
    const push: Push = (ws, event) => {
      const list = outbox.get(ws) ?? [];
      list.push(event);
      outbox.set(ws, list);
    };
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));

    for (const { eventName, data } of events) {
      const event: EventContext = { eventName, data, sendFrom: seat.peerId };
      const toAddressee = () => {
        if (to === undefined) for (const other of others) push(other.ws, event);
        else if (target) push(target.ws, event);
      };
      switch (eventName) {
        case SyncEvent.UPDATE:
          this.update(data, seat, sender, push);
          break;
        case SyncEvent.DELETE:
          this.remove(event, seat, sender, push);
          break;
        case SyncEvent.FORGET_DELETED:
          if (this.forget(data, seat)) for (const other of others) push(other.ws, event);
          break;
        case AuthorityEvent.ROLE_REQUEST:
          if (forAuthority) this.changeRole(data, seat, reply);
          else toAddressee();
          break;
        case AuthorityEvent.ROLL_REQUEST:
          if (forAuthority) this.requestRoll(data, seat, sender);
          else toAddressee();
          break;
        case SyncEvent.CATALOG:
          if (forAuthority) this.answerCatalog(data, seat, reply);
          else toAddressee();
          break;
        case SyncEvent.REQUEST:
          if (forAuthority) this.answerRequest(data, seat, reply);
          else toAddressee();
          break;
        case SyncEvent.REQUEST_CATALOG:
          if (forAuthority) for (const catalog of this.catalogEvents(seat)) push(sender, catalog);
          else toAddressee();
          break;
        default:
          toAddressee();
      }
    }

    this.deliver(outbox, (ws) => (ws === sender ? AUTHORITY_PEER_ID : seat.peerId));
    if (this.store.hasPending) this.scheduleFlush();
  }

  /**
   * 受け取る人ごとの束を送る。同じ並びのイベントを受け取る人たちには、1度だけ符号にして送る
   */
  private deliver(outbox: Map<WebSocket, EventContext[]>, fromOf: (ws: WebSocket) => string): void {
    const ids = new Map<EventContext, number>();
    const frames = new Map<string, Uint8Array>();
    for (const [ws, events] of outbox) {
      const from = fromOf(ws);
      const key = `${from}:${events.map((event) => ids.get(event) ?? ids.set(event, ids.size).get(event)).join(',')}`;
      let frame = frames.get(key);
      if (!frame) {
        frame = encodeFrame({ type: 'data', from, events });
        frames.set(key, frame);
      }
      this.sendFrame(ws, frame);
    }
  }

  /**
   * UPDATE を状態に当て、見てよい人へ見てよい形で配る。
   *
   * 送り主から見えないものには書かせない（WITHDRAW を返す）。伏せた形で持っている人が書き戻して
   * きたら、伏せたところを置いてある中身に戻す。PeerCursor の役割は、その人の席の役割で上書きする。
   * 見学者は、自分のカーソルと、見学者も話せるタブへの発言しか書けない。
   */
  private update(data: unknown, seat: Seat, sender: WebSocket, push: Push): void {
    const parsed = safeParse(objectContextSchema, data);
    if (!parsed.success) return;
    let context = parsed.output;
    const { identifier, aliasName } = context;
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));

    // 置いてあるものの種類は変えさせない。カーソルを名乗って、ほかのものを上書きさせないため
    const existing = this.store.entryOf(identifier);
    if (existing && existing.alias !== aliasName) return this.refuseWrite(identifier, seat, reply);
    // 大きすぎる見え方の手がかりは、索引にも SQLite の1行にも置けない。新しいものは数も絞る
    if (!fitsIndex(context) || (!existing && this.store.size >= MAX_OBJECTS))
      return this.refuseWrite(identifier, seat, reply);

    const seen = this.kindOf(identifier, seat);
    if (seen === 'hidden') return reply(AuthorityEvent.WITHDRAW, { identifier });
    if (seen === 'masked') context = unmasked(context, this.store.get(identifier) as ObjectContext);
    if (
      existing &&
      seat.role !== 'gm' &&
      (!mayChangeView(existing.view, describe(context).view, seat) ||
        this.uncovers(context, existing, seat))
    )
      return this.refuseWrite(identifier, seat, reply);

    let owner: string | null = null;
    // 伏せた形で持っている人には、受けたあとも伏せた形（伏せた版）を持たせる。見えるようになったときに
    // 版の違いで取り直せるように
    let corrected = seen === 'masked';
    if (aliasName === PEER_CURSOR_ALIAS) {
      owner = String(context.syncData.peerId);
      // 出ていった人のカーソルは置かない。クライアントは leave を受けて自分で片付ける
      const ownerSeat = this.seats().find((other) => other.seat.peerId === owner)?.seat;
      if (!ownerSeat) return;
      if (seat.role === 'guest' && owner !== seat.peerId)
        return this.refuseWrite(identifier, seat, reply);
      if (context.syncData.role !== ownerSeat.role) {
        context = { ...context, syncData: { ...context.syncData, role: ownerSeat.role } };
        corrected = true;
      }
    } else if (seat.role === 'guest' && !this.guestMayWrite(context, seat)) {
      return this.refuseWrite(identifier, seat, reply);
    }
    if (aliasName === CHAT_MESSAGE_ALIAS) {
      const kept = this.keepRolledFields(context, seat);
      corrected ||= kept !== context;
      context = kept;
    }

    const verdict = judgeUpdate(
      this.store.entryOf(identifier),
      context,
      owner === null && this.store.isDeleted(identifier),
    );
    if (verdict === 'stale') {
      reply(SyncEvent.UPDATE, this.viewOf(identifier, seat));
    } else if (verdict === 'deleted') {
      reply(SyncEvent.DELETE, { aliasName, identifier });
    } else if (verdict === 'accept') {
      const before = this.store.lookup(identifier);
      this.store.put(context, owner);
      this.spread(context, before, seat, sender, push, corrected);
    }
  }

  /**
   * 親か名前（データ要素の名前は、カードやメモの下のどこにあるかを決める）を変える書き込みで、
   * 書いた人自身に、そのものか子孫が今より見えるようになるか。見え方は親と名前の道筋で決まるので、
   * 名前を変えたり、決まりを持つ親の下から外したりすれば、伏せたものが手に入ってしまう
   */
  private uncovers(context: ObjectContext, existing: StoredEntry, seat: Seat): boolean {
    const next = describe(context);
    const renamed =
      existing.view?.kind === 'data' &&
      next.view?.kind === 'data' &&
      existing.view.name !== next.view.name;
    if (next.parent === existing.parent && !renamed) return false;
    const identifier = context.identifier;
    const after: Lookup = (other) =>
      other === identifier ? { ...existing, ...next } : this.store.lookup(other);
    return [identifier, ...this.store.dependentsOf(identifier)].some((other) =>
      looser(this.kindOf(other, seat, after), this.kindOf(other, seat)),
    );
  }

  /**
   * 置いたものを配る。ほかの人には見てよい形で（見えなくなった人には WITHDRAW）、送り主には、
   * 送ってきたものと見え方や中身が違えば直したものを返す。見え方が変わったら、それで見え方の
   * 決まるもの（子孫、リアクション）も、見えるようになった人に渡し、見えなくなった人から外させる
   */
  private spread(
    context: ObjectContext,
    before: StoredEntry | null,
    seat: Seat,
    sender: WebSocket,
    push: Push,
    corrected: boolean,
  ): void {
    const { identifier } = context;
    const was: Lookup = (other) => (other === identifier ? before : this.store.lookup(other));
    for (const { ws, seat: other } of this.seats(sender)) {
      const then = before ? this.kindOf(identifier, other, was) : 'hidden';
      const now = this.kindOf(identifier, other);
      if (delivered(now)) {
        push(ws, {
          eventName: SyncEvent.UPDATE,
          data: viewFor(context, now),
          sendFrom: seat.peerId,
        });
      } else if (delivered(then)) {
        push(ws, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
      }
    }
    // 親がまだ届いていないもの（pending）は、送り主の手元にあるままにする
    const mine = this.kindOf(identifier, seat);
    if (mine === 'hidden') push(sender, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
    else if (corrected && delivered(mine)) {
      push(sender, fromAuthority(AuthorityEvent.AUTHORITATIVE, viewFor(context, mine)));
    }

    // 見え方の手がかりか親が変わったか、初めて届いたもの（その子が親を待っていたかもしれない）なら、
    // 子孫の見え方を比べ直す
    const after = this.store.lookup(identifier) as StoredEntry;
    if (
      !before ||
      before.parent !== after.parent ||
      JSON.stringify(before.view) !== JSON.stringify(after.view)
    ) {
      this.revisit(this.store.dependentsOf(identifier), this.seats(), was, push, sender);
    }
  }

  /**
   * 見え方の決まるもとが変わったので、そのものの見え方を人ごとに比べ直す。見えるようになった人には
   * AUTHORITATIVE_OBJECT で渡し（版が同じでも置き換わる）、見えなくなった人には WITHDRAW で外させる。
   *
   * 親を待っていたもの（pending）が見えるようになったとき、writer には渡さない。親を待つ子を作れるのは、
   * その親を持っている人（親を送ってきた本人）だけなので、writer はもう持っている
   */
  private revisit(
    identifiers: string[],
    seats: { ws: WebSocket; seat: Viewer }[],
    was: Lookup,
    push: Push,
    writer?: WebSocket,
  ): void {
    for (const { ws, seat } of seats) {
      for (const identifier of identifiers) {
        const then = viewKind(identifier, seat, was);
        if (ws === writer && then === 'pending') continue;
        this.resend(ws, identifier, then, viewKind(identifier, seat, this.store.lookup), push);
      }
    }
  }

  /** 見え方が then から now に変わったものを、その人に渡すか外させる。変わらなければ何もしない */
  private resend(
    ws: WebSocket,
    identifier: string,
    then: ViewKind,
    now: ViewKind,
    push: Push,
  ): void {
    if (then === now) return;
    if (!delivered(now)) {
      if (delivered(then)) push(ws, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
      return;
    }
    const context = this.store.get(identifier) as ObjectContext;
    push(ws, fromAuthority(AuthorityEvent.AUTHORITATIVE, viewFor(context, now)));
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
   * サーバーが振った結果の発言は、結果と名前と送り主を書き換えさせない。ただし振った人と GM は、
   * シークレットを公開してよい（tag から secret の語を外すことだけ。Axe の discloseMessage と同じ）。
   * サーバーが振っていない発言には、サーバーが振った印を付けさせない。直したら、直した中身を返す
   * （直さなければ受けたまま）
   */
  private keepRolledFields(context: ObjectContext, seat: Seat): ObjectContext {
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
    const original = attributesOf(stored);
    const disclosed =
      (original.originFrom === seat.userId || seat.role === 'gm') &&
      isDisclosureOf(original.tag, attributes.tag);
    const kept = disclosed ? { ...original, tag: attributes.tag } : original;
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
   * コマンドでなければ何もしない。見学者は、自分が発言できるタブでだけ振れる。
   * 結果は見てよい人へ見てよい形で配る（秘話の宛先、シークレットなら伏せた形）
   */
  private requestRoll(data: unknown, seat: Seat, sender: WebSocket): void {
    const parsed = safeParse(rollRequestSchema, data);
    if (!parsed.success) return;
    const request = parsed.output;
    const { message } = request;
    if (message.aliasName !== CHAT_MESSAGE_ALIAS) return;
    if (seat.role === 'guest' && !this.guestMayWrite(message, seat)) return;
    // 振るのは重いので、頼める数を絞る。超えたものは振らない
    if (!this.withinRolls(sender) || this.pendingRolls >= MAX_PENDING_ROLLS) return;

    this.pendingRolls += 1;
    this.rollQueue = this.rollQueue
      .then(async () => {
        // 1つ振るごとに、ほかのメッセージに順番を譲る
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = Date.now();
        const rolled = await rollLine(request.gameSystem, request.command);
        // 振っているあいだに部屋が削除されていたら、置く先が無い
        if (!this.room()) return;
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
        for (const { ws, seat: other } of this.seats()) {
          const view = viewFor(result, this.kindOf(result.identifier, other));
          if (view) {
            this.post(ws, {
              type: 'data',
              from: AUTHORITY_PEER_ID,
              events: [fromAuthority(SyncEvent.UPDATE, view)],
            });
          }
        }
      })
      .catch((err: unknown) => console.error('Roll failed:', err))
      .finally(() => {
        this.pendingRolls -= 1;
      });
    this.ctx.waitUntil(this.rollQueue);
  }

  /**
   * 書く権限の無い変更を、送り主の手元で戻させる。サーバーが持っていればその人に見せる形に戻し、
   * 消したものなら消させ、どちらでもなければ（新しく作ろうとしたもの）印を残さずに取り下げさせる
   */
  private refuseWrite(identifier: string, seat: Seat, reply: Reply): void {
    const view = this.viewOf(identifier, seat);
    if (view) reply(AuthorityEvent.AUTHORITATIVE, view);
    else if (this.store.isDeleted(identifier))
      reply(SyncEvent.DELETE, { aliasName: '', identifier });
    else reply(AuthorityEvent.WITHDRAW, { identifier });
  }

  /**
   * DELETE を状態に当てる。見学者が消せるのは自分のカーソルだけ。見えないものは消させない。
   *
   * 消したものの子孫も一緒に消す。送り主から見えなかった子孫（裏向きのカードの表など）は、送り主の
   * 手元に無いので送り主からは消しに来ない。持っている人には、サーバーから DELETE を送る
   */
  private remove(event: EventContext, seat: Seat, sender: WebSocket, push: Push): void {
    const parsed = safeParse(deleteSchema, event.data);
    if (!parsed.success) return;
    const { aliasName, identifier } = parsed.output;
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));
    const entry = this.store.entryOf(identifier);
    // 子孫として、もう消してある
    if (!entry && this.store.isDeleted(identifier)) return;
    if (this.kindOf(identifier, seat) === 'hidden') return;
    const owner = entry?.owner ?? null;
    if (seat.role === 'guest' && owner !== seat.peerId)
      return this.refuseWrite(identifier, seat, reply);

    const doomed = [identifier, ...this.store.descendantsOf(identifier)];
    const others = this.seats(sender);
    const seen = new Map(
      others.map(({ ws, seat: other }) => [ws, doomed.map((id) => this.kindOf(id, other))]),
    );
    const cursor = aliasName === PEER_CURSOR_ALIAS || owner !== null;
    for (const id of doomed) this.store.delete(id, !cursor);
    for (const { ws } of others) {
      doomed.forEach((id, index) => {
        if (!delivered((seen.get(ws) as ViewKind[])[index])) return;
        push(
          ws,
          id === identifier
            ? event
            : fromAuthority(SyncEvent.DELETE, { aliasName: '', identifier: id }),
        );
      });
    }
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
   * 書き換えて版を上げ、全員に配る。役割で見え方が変わるもの（裏向きのカードの表、シークレット、
   * タブの発言など）は、その人に渡すか外させる。断るときは、頼んだ人に理由を返す
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
    this.notifyLobby(seat.roomKey);
    const outbox = new Map<WebSocket, EventContext[]>();
    const push: Push = (ws, event) => outbox.set(ws, [...(outbox.get(ws) ?? []), event]);
    const updates: EventContext[] = [];
    for (const { ws, seat: other } of this.seats()) {
      if (other.userId !== target.userId) continue;
      ws.serializeAttachment({ ...other, role });
      // すべてのものを、前の役割と今の役割で見比べる
      for (const identifier of this.store.identifiers()) {
        this.resend(
          ws,
          identifier,
          this.kindOf(identifier, other),
          this.kindOf(identifier, { ...other, role }),
          push,
        );
      }
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
    for (const { ws } of this.seats()) for (const update of updates) push(ws, update);
    this.deliver(outbox, () => AUTHORITY_PEER_ID);
    // アセットを置けるかは役割で決まるので、新しい役割のトークンに替えさせる
    for (const { ws, seat: other } of this.seats()) {
      if (other.userId !== target.userId) continue;
      this.post(ws, { type: 'asset-token', ...this.assetTokenFor(other, 'expiresAt') });
    }
  }

  /**
   * クライアントのカタログに答える。サーバーが持っていないか古いものは送ってもらい、
   * 消したものは消させ、その人から見えないものは手元から外させる。
   * サーバーの方が新しいものは、クライアントがサーバーのカタログを見て取りに来る
   */
  private answerCatalog(data: unknown, seat: Seat, reply: Reply): void {
    const parsed = safeParse(catalogSchema, data);
    if (!parsed.success) return;
    for (const { identifier, version } of parsed.output) {
      if (this.store.isDeleted(identifier)) {
        reply(SyncEvent.DELETE, { aliasName: '', identifier });
        continue;
      }
      if (this.kindOf(identifier, seat) === 'hidden') {
        reply(AuthorityEvent.WITHDRAW, { identifier });
        continue;
      }
      const stored = this.store.entryOf(identifier);
      if (!stored || stored.majorVersion + stored.minorVersion < version) {
        reply(SyncEvent.REQUEST, identifier);
      }
    }
  }

  /** 頼まれたものを、その人に見せる形で返す。見せないものには何も返さない */
  private answerRequest(data: unknown, seat: Seat, reply: Reply): void {
    const parsed = safeParse(requestSchema, data);
    if (!parsed.success) return;
    const identifier = parsed.output;
    if (this.store.isDeleted(identifier)) {
      reply(SyncEvent.DELETE, { aliasName: '', identifier });
      return;
    }
    const view = this.viewOf(identifier, seat);
    if (view) reply(SyncEvent.UPDATE, view);
  }

  /**
   * その人に見せるカタログ。見せないものは載せない。空でも1件は送り、
   * カタログを送り終えたことがわかるようにする
   */
  private catalogEvents(seat: Seat): EventContext[] {
    const catalog = this.store.catalog().flatMap((item) => {
      const kind = this.kindOf(item.identifier, seat);
      if (!delivered(kind)) return [];
      if (kind === 'full') return [item];
      // 伏せた形を渡すときと同じ、本物より小さい版を載せる
      const entry = this.store.entryOf(item.identifier) as StoredEntry;
      return [{ ...item, version: entry.majorVersion + maskedMinor(entry.minorVersion) }];
    });
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
      .exec<RoomRow>(
        'SELECT room_key, room_id, name, password_salt, password_hash, host, emptied_at FROM room',
      )
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

  /** だれもいなくなった。ここから保持期間を数える */
  private markEmptied(): void {
    this.ctx.storage.sql.exec('UPDATE room SET emptied_at = ?', Date.now());
    void this.ctx.storage.setAlarm(Date.now() + this.retentionMs());
  }

  private retentionMs(): number {
    return parseConfig(this.env).roomRetentionSeconds * 1000;
  }

  /**
   * トークンを確かめる鍵。部屋はログインを置いた Worker でしか作れないが、あとでログインを外すと
   * null になる。そのあいだはトークンを確かめも作りもしない（見学では入れる）
   */
  private sessionSecret(): string | null {
    return parseConfig(this.env).login?.sessionSecret ?? null;
  }

  private lobby() {
    return this.env.LOBBY.getByName(LOBBY_NAME);
  }

  /**
   * 一覧の人数と GM を直す。知らせる順に並べ、どちらも知らせるときに数える。
   * それまでに部屋が削除されていれば知らせない
   */
  private notifyLobby(roomKey: string): void {
    this.lobbyQueue = this.lobbyQueue
      .then(async () => {
        if (!this.room()) return;
        const gameMasters = this.ctx.storage.sql
          .exec<{ user_id: string }>("SELECT user_id FROM seats WHERE role = 'gm'")
          .toArray()
          .map((row) => row.user_id);
        await this.lobby().setMembers(roomKey, this.seats().length);
        await this.lobby().setGameMasters(roomKey, gameMasters);
      })
      .catch((err: unknown) => console.error('Lobby update failed:', err));
    this.ctx.waitUntil(this.lobbyQueue);
  }
}
