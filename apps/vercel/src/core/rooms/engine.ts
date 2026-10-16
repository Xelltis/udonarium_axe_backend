import { safeParse } from 'valibot';

import {
  ACCOUNT_USER_ID_PREFIX,
  AUTHORITY_ONLY_EVENTS,
  AUTHORITY_PEER_ID,
  AuthorityEvent,
  CATALOG_BATCH,
  CHAT_MESSAGE_ALIAS,
  CHAT_TAB_ALIAS,
  CHAT_TAB_LIST_IDENTIFIER,
  CLOSE_CODE,
  DICE_BOT_SENDER,
  MAX_MEMBERS,
  MAX_ROLLS_PER_WINDOW,
  MAX_VERSION_STEP,
  PEER_CURSOR_ALIAS,
  PROTOCOL_VERSION,
  SERVER_ROLL_FIELD,
  SyncEvent,
  judgeUpdate,
} from '../../../contracts/protocol.js';
import type {
  AssetUploadPolicy,
  ErrorCode,
  EventContext,
  ObjectContext,
  PeerRole,
  RoleRejectReason,
  RollRejectReason,
  ServerMessage,
} from '../../../contracts/protocol.js';
import { ASSET_TOKEN_SECONDS, INVITE_SECONDS, readToken, signToken } from '../auth/tokens.js';
import { rollLine } from '../dice/roll.js';
import { decodeFrame, encodeFrame } from './codec.js';
import type { RoomHost, RoomStore, Seat } from './host.js';
import {
  FLUSH_DELAY_MS,
  FLUSH_TALLY_MS,
  HELLO_TIMEOUT_MS,
  KEEP_FROM_DELETING_MS,
  MAX_EVENTS_PER_WINDOW,
  MAX_FRAMES_PER_WINDOW,
  MAX_OBJECTS,
  MAX_PENDING_ROLLS,
  MAX_SOCKETS,
  OCCUPIED_CHECK_MS,
  RATE_WINDOW_MS,
  TOKEN_GRACE_MS,
} from './limits.js';
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
} from './messages.js';
import type { StoredEntry } from './object-index.js';
import { attributesOf, withAttributes } from './objects.js';
import { verifyPassword } from './password.js';
import {
  RESERVED_USER_IDS,
  ROLLED_ATTRIBUTES,
  ROLLED_GM_ATTRIBUTES,
  ROLLED_PLACE,
  fitsIndex,
  fromAuthority,
  indexFraction,
  isDisclosureOf,
  isHello,
  isSamePerson,
  mayChangeView,
  mayClaimPeerId,
  memberOf,
  movesTab,
  neutralRollAttributes,
  notLongAgo,
} from './rules.js';
import { delivered, describe, looser, maskedMinor, unmasked, viewFor, viewKind } from './visibility.js';
import type { Lookup, ViewKind, Viewer } from './visibility.js';

type Reply = (eventName: string, data: unknown) => void;

/** 受け取る人ごとの束に、イベントを1つ足す */
type Push<C> = (conn: C, event: EventContext) => void;

/**
 * 1つの部屋の中継と同期。部屋にいる人の接続から届いたものを読み、部屋の状態に当て、見てよい人へ
 * 見てよい形で配る。
 *
 * クライアントからは、全部を持っている特別なピア（AUTHORITY_PEER_ID）に見える。カタログの交換は
 * このピアとだけ行い、UPDATE と DELETE はここで LWW に当ててから配る。
 *
 * 接続・席・部屋の行・役割・置き場所は RoomHost が持つ。どの部屋のサーバー（Cloudflare の Durable Object、
 * Vercel の部屋の持ち主）でも同じに動くよう、ここは1つの部屋の1つの流れの中で、同期で動く。確かめてから
 * 書くまでのあいだに await を挟まない。メモリに置くのは、消えても困らないもの（送りすぎの数、振るのを
 * 待っている数、しばらく消させないもの）だけ。
 */
export class RoomEngine<C extends object> {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** まだ記録していない、書いた変更の数と、数え始めた時刻 */
  private flushTally = { count: 0, since: 0 };
  /** 頼まれた順に振る。システムを初めて読み込むときだけ待つ */
  private rollQueue: Promise<void> = Promise.resolve();
  /** 送ってきたフレーム・イベント・ダイスの数。窓の始まりと、そこからの数 */
  private readonly rates = new WeakMap<C, { start: number; count: number; events: number; rolls: number }>();
  /** 切れたと知らされたもの */
  private readonly gone = new WeakSet<C>();
  /** 断って閉じたもの。hello の前に断ったものは席が無いので、ここで覚える */
  private readonly refused = new WeakSet<C>();
  /** hello の前の接続を受けた時刻。消えていたら、待ちすぎたものとみなす */
  private readonly connectedAt = new WeakMap<C, number>();
  /** 振るのを待っているダイスの数 */
  private pendingRolls = 0;
  /**
   * ユーザー ID ごとに、親を待っているあいだにカタログで外させたもの。書いた本人でも、もう持っていないので、
   * 親が来て見えるようになったら渡す。つなぎ直しても同じ人なので、接続ではなくユーザー ID で持つ
   */
  private withdrawnPending = new Map<string, Set<string>>();
  /** 席ごとに、消させなかったものとその子孫と、それをいつまで消させないか */
  private keptFromDeleting = new Map<string, { ids: Set<string>; until: number }>();

  constructor(private readonly host: RoomHost<C>) {}

  private get store(): RoomStore {
    return this.host.store();
  }

  /**
   * 接続を受ける。部屋が無いときと満員のときも、受けてから理由を送って閉じる。受ける前に HTTP で断ると、
   * ブラウザには理由が読めず、つながらなかったことしかわからない
   */
  accept(conn: C): void {
    const missing = this.host.wiping() || !this.host.room();
    if (!missing) this.closeSilentSockets(conn);
    const full =
      !missing &&
      this.host.connections().filter((other) => other !== conn && !this.gone.has(other) && !this.refused.has(other))
        .length >= MAX_SOCKETS;
    if (missing) this.refuse(conn, 'room-not-found');
    else if (full) this.refuse(conn, 'room-full');
    else this.connectedAt.set(conn, Date.now());
  }

  /**
   * 部屋を削除したので、入っている人に room-deleted を送ってから閉じる。出たことにはしない
   * （知らせる相手も、書き残す部屋も無くなる）
   */
  closeAll(): void {
    for (const conn of this.host.connections()) {
      if (this.gone.has(conn) || this.refused.has(conn)) continue;
      this.refused.add(conn);
      const seat = this.host.seatOf(conn);
      if (seat) this.host.setSeat(conn, { ...seat, closed: true });
      this.post(conn, { type: 'error', code: 'room-deleted', protocolVersion: PROTOCOL_VERSION });
      this.host.close(conn, CLOSE_CODE, 'room-deleted');
    }
  }

  /** 部屋にいない人のカーソルを消し、持っている人に消させる。部屋のサーバーが落ちたあとの片付け */
  dropStrayCursors(): void {
    this.dropCursors(this.removeStrayCursors());
  }

  /** まとめて書くのをやめる。部屋を消すときに */
  stopFlushing(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * アセットを置こうとしている人が、いまもこの部屋で置ける役割（GM か PL）か。アセットの PUT から尋ねる。
   * トークンは15分使えるので、そのあいだに部屋が消えたり、見学に変えられたりしていれば断る
   */
  canUpload(userId: string): 'ok' | 'room-not-found' | 'not-a-player' {
    if (this.host.wiping() || !this.host.room()) return 'room-not-found';
    // 席に着いているあいだだけ。抜けた人は、トークンが残っていても置けない
    const seated = this.seats().some(
      ({ seat }) => seat.account && seat.userId === userId && (seat.role === 'gm' || seat.role === 'pl')
    );
    return seated ? 'ok' : 'not-a-player';
  }

  /**
   * hello を送らないまま HELLO_TIMEOUT_MS を過ぎた接続を閉じる。閉じないと、hello を送らない接続で
   * 部屋を満員にできてしまう
   */
  private closeSilentSockets(except: C): void {
    const now = Date.now();
    for (const conn of this.host.connections()) {
      if (conn === except || this.host.seatOf(conn) || this.gone.has(conn) || this.refused.has(conn)) continue;
      const at = this.connectedAt.get(conn);
      if (at === undefined || now - at > HELLO_TIMEOUT_MS) this.refuse(conn, 'hello-required');
    }
  }

  /**
   * アクセストークンが切れてから TOKEN_GRACE_MS を過ぎても新しいトークンが届かない席を外す。
   * ログアウトしたり、アカウントを消したりした人が、つながったまま見続けないように
   */
  expireSeats(): void {
    const now = Date.now();
    for (const { conn, seat } of this.seats()) {
      if (seat.expiresAt !== undefined && now > seat.expiresAt + TOKEN_GRACE_MS) {
        this.refuse(conn, 'unauthorized');
      }
    }
  }

  /** 接続から届いたものを受ける */
  receive(conn: C, message: string | ArrayBuffer | Uint8Array): void {
    // PING には部屋のサーバーが答えるので、ここに来るテキストは使わない。黙って捨てると、数えられないまま
    // 部屋を起こし続けられるので、断って閉じる
    if (typeof message === 'string') return this.refuse(conn, 'bad-message');
    this.expireSeats();
    const seat = this.host.seatOf(conn);
    if (seat?.closed || this.refused.has(conn)) return;
    // 消しているあいだに届いたものは受けない（席を作らせず、トークンも渡し直さない）
    if (this.host.wiping()) return this.refuse(conn, seat ? 'room-deleted' : 'room-not-found');
    if (!this.withinRate(conn)) return this.refuse(conn, 'too-many-messages');

    let decoded: unknown;
    try {
      decoded = decodeFrame(message);
    } catch {
      return this.refuse(conn, 'bad-message');
    }
    if (!seat) return this.greet(conn, decoded);

    const parsed = safeParse(clientMessageSchema, decoded);
    if (!parsed.success) return this.refuse(conn, 'bad-message');
    const received = parsed.output;
    if (received.type === 'send') {
      if (!this.withinEvents(conn, received.events.length)) return this.refuse(conn, 'too-many-messages');
      this.relay(conn, seat, received.to ?? undefined, received.events);
    } else if (received.type === 'time') {
      this.post(conn, { type: 'time', serverTime: Date.now() });
    } else if (received.type === 'invite') {
      this.invite(conn, seat, received.role);
    } else if (received.type === 'auth') {
      this.renew(conn, seat, received.accessToken);
    } else if (received.type === 'asset-token') {
      this.post(conn, {
        type: 'asset-token',
        ...this.assetTokenFor(seat, 'expiresAt'),
        role: seat.role,
      });
    }
    // 入ったあとの hello は何もしない
  }

  // ---- 入退室 ----

  private greet(conn: C, decoded: unknown): void {
    if (!isHello(decoded)) return this.refuse(conn, 'hello-required');
    if (decoded.protocolVersion !== PROTOCOL_VERSION) return this.refuse(conn, 'protocol-mismatch');
    const parsed = safeParse(helloSchema, decoded);
    if (!parsed.success) return this.refuse(conn, 'bad-message');
    const hello = parsed.output;

    const room = this.host.room();
    if (!room) return this.refuse(conn, 'room-not-found');
    if (room.password && !verifyPassword(hello.password ?? '', room.password)) {
      return this.refuse(conn, 'wrong-password');
    }

    // ログインしていなければ見学。ログインしていれば、トークンの人と userId が同じでなければならない
    const seat: Seat = {
      peerId: hello.peerId,
      userId: hello.userId,
      roomKey: room.roomKey,
      role: 'guest',
      account: false,
      joinedAt: Date.now(),
    };
    if (
      !hello.accessToken &&
      (hello.userId.startsWith(ACCOUNT_USER_ID_PREFIX) || this.host.roles.roleOf(hello.userId) !== null)
    ) {
      // ログインした人のユーザー ID は、トークン無しには名乗らせない（その人に見えるものが見えてしまう）。
      // 頭の付かない前の形のアカウントもあるので、この部屋に入ったことのあるアカウントも見る
      return this.refuse(conn, 'unauthorized');
    }
    // 発言の送り主に使う名前（ダイスボットなど）は名乗らせない。サーバーが振った発言の送り主と
    // みなされ、シークレットや秘話が見えてしまう
    if (RESERVED_USER_IDS.has(hello.userId)) return this.refuse(conn, 'bad-message');
    // ほかの人のピア ID を名乗らせない。名乗れると、その人が抜けたすきに席を取り、戻ってきた本人を締め出せる
    if (!mayClaimPeerId(hello.userId, hello.peerId)) return this.refuse(conn, 'bad-message');
    if (hello.accessToken) {
      const secret = this.host.sessionSecret();
      const claims = secret ? readToken(hello.accessToken, 'access', secret) : null;
      if (!secret || !claims || claims.uid !== hello.userId) return this.refuse(conn, 'unauthorized');
      const { role, known } = this.roleOf(hello.userId, hello.invite ?? null, room.roomKey, secret);
      seat.role = role;
      seat.account = true;
      seat.expiresAt = claims.exp * 1000;
      // 役割を覚えるのは、席に着けたときだけ。断られた人の招待は、次に入るときにも効く
      if (this.seat(conn, seat) && !known) {
        this.host.roles.add(hello.userId, role);
      }
      return;
    }
    this.seat(conn, seat);
  }

  /**
   * ログインした人の役割。前に入ったことがあればそのときの役割、初めてなら招待の役割、
   * 招待が無いか、この部屋のものでなければ PL。known は、前に入ったことがあるか。
   * GM の招待は、出した人がもう GM でなければ無いものとみなす。GM を外された人が前に出した招待で、
   * GM を増やさせない。アカウントを消した人の席の行は部屋に残るので、その人の招待は GM のまま効く
   */
  private roleOf(
    userId: string,
    invite: string | null,
    roomKey: string,
    secret: string
  ): { role: PeerRole; known: boolean } {
    const known = this.host.roles.roleOf(userId);
    if (known) return { role: known, known: true };
    const invited = invite ? readToken(invite, 'invite', secret) : null;
    if (invited?.room !== roomKey) return { role: 'pl', known: false };
    if (invited.role === 'gm' && invited.by !== undefined && this.host.roles.roleOf(invited.by) !== 'gm') {
      return { role: 'pl', known: false };
    }
    return { role: invited.role, known: false };
  }

  /**
   * この部屋のアセットを読み書きするトークンと、それが切れる時刻（Unix ミリ秒）。時刻は expiresAt の名前で
   * 返す（welcome と asset-token で名前が違う）。役割を入れておき、置けるのは GM と PL だけにする
   */
  /** アセットの置き方。PUT だけで置ける部屋のサーバー（Cloudflare 版）は、welcome に付けない */
  private uploadPolicy(): { assetUpload?: AssetUploadPolicy } {
    const policy = this.host.assetUploadPolicy();
    return policy ? { assetUpload: policy } : {};
  }

  private assetTokenFor<K extends string>(seat: Seat, expiresAt: K): { assetToken: string } & Record<K, number> {
    const secret = this.host.sessionSecret();
    // ログインを外した部屋のサーバーでは、アセットの経路もトークンを受けないので、空にしておく
    if (!secret) return { assetToken: '', [expiresAt]: 0 } as { assetToken: string } & Record<K, number>;
    const assetToken = signToken<'asset'>(
      { aud: 'asset', room: seat.roomKey, role: seat.role, uid: seat.userId },
      ASSET_TOKEN_SECONDS,
      secret
    );
    return { assetToken, [expiresAt]: Date.now() + ASSET_TOKEN_SECONDS * 1000 } as {
      assetToken: string;
    } & Record<K, number>;
  }

  /** GM に頼まれて、招待を作る。GM でないか、ログインを外した部屋のサーバーなら invite を null にして返す */
  private invite(conn: C, seat: Seat, role: PeerRole): void {
    const secret = this.host.sessionSecret();
    if (seat.role !== 'gm' || !secret) {
      this.post(conn, { type: 'invite', role, invite: null, expiresAt: null });
      return;
    }
    const invite = signToken<'invite'>(
      { aud: 'invite', room: seat.roomKey, role, by: seat.userId },
      INVITE_SECONDS,
      secret
    );
    this.post(conn, {
      type: 'invite',
      role,
      invite,
      expiresAt: Date.now() + INVITE_SECONDS * 1000,
    });
  }

  /**
   * つながったまま、新しいアクセストークンを受ける。同じ人のものなら席の期限を延ばし、そうでなければ
   * 外す。見学の席には期限が無いので、受けても何もしない
   */
  private renew(conn: C, seat: Seat, accessToken: string): void {
    if (!seat.account) return;
    const claims = readToken(accessToken, 'access', this.host.sessionSecret() ?? '');
    if (!claims || claims.uid !== seat.userId) return this.refuse(conn, 'unauthorized');
    this.host.setSeat(conn, { ...seat, expiresAt: claims.exp * 1000 });
  }

  /** 席に着ける。着けたら true、断ったら false */
  private seat(conn: C, seat: Seat): boolean {
    let others = this.seats(conn);
    let previous = others.find((other) => other.seat.peerId === seat.peerId);
    if (previous && !isSamePerson(previous.seat, seat)) {
      // ほかの人のピア ID を名乗るものは入れない。入れると、その人を追い出して成り代われてしまう。
      // ただし、ログインした人のピア ID を見学が先に取っていたら、見学のほうを外す。ピア ID は
      // ユーザー ID から作るので、ログインした人のピア ID を持てるのはその人だけ
      if (previous.seat.account || !seat.account) {
        this.refuse(conn, 'bad-message');
        return false;
      }
      this.refuse(previous.conn, 'bad-message');
      others = this.seats(conn);
      previous = undefined;
    }
    if (seat.account) {
      // ログインした人のユーザー ID を、トークン無しで名乗っていた見学は外す。見え方はユーザー ID で
      // 決まるので、残せばその人の手札や秘話がその見学にも届く
      for (const other of others) {
        if (!other.seat.account && other.seat.userId === seat.userId) {
          this.refuse(other.conn, 'unauthorized');
        }
      }
      others = this.seats(conn);
      previous = others.find((other) => other.seat.peerId === seat.peerId);
    }
    if (!previous && others.length >= MAX_MEMBERS) {
      this.refuse(conn, 'room-full');
      return false;
    }
    if (previous) {
      // 同じ人がつなぎ直した。古い方は、もう切れているのに残っているもの。読み直したページの
      // カーソルは別の識別子になるので、古い方のカーソルは消してほかの人にも消させる
      this.refuse(previous.conn, 'replaced');
      this.dropCursors(this.store.removeOwnedBy(seat.peerId), conn);
    }

    this.host.setSeat(conn, seat);
    // 部屋のサーバーが落ちて、出ていく知らせの来なかった人のカーソルが残っていれば、ここで片付ける
    this.dropCursors(this.removeStrayCursors(), conn);
    this.post(conn, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      peerId: seat.peerId,
      authorityPeerId: AUTHORITY_PEER_ID,
      role: seat.role,
      members: others.filter((other) => other !== previous).map((other) => memberOf(other.seat)),
      serverTime: Date.now(),
      ...this.assetTokenFor(seat, 'assetTokenExpiresAt'),
      ...this.uploadPolicy(),
    });
    this.post(conn, { type: 'data', from: AUTHORITY_PEER_ID, events: this.catalogEvents(seat) });
    // 人がいるあいだは消さずに見回る
    this.host.occupied(this.nextCheckAt());
    if (previous) return true;
    this.broadcast(conn, { type: 'join', member: memberOf(seat) });
    this.host.lobbyChanged(seat.roomKey);
    this.host.record('join', seat.role, this.seats().length);
    return true;
  }

  /**
   * 次に見回る時刻。ふだんは OCCUPIED_CHECK_MS ごと。ログインした席のトークンがそれより先に切れるなら、
   * 切れて TOKEN_GRACE_MS を過ぎたころにも見る。だれも何も送らない部屋でも、切れた席を外すため
   */
  nextCheckAt(): number {
    const expiries = this.seats().flatMap(({ seat }) =>
      seat.expiresAt === undefined ? [] : [seat.expiresAt + TOKEN_GRACE_MS + 1000]
    );
    return Math.min(Date.now() + OCCUPIED_CHECK_MS, ...expiries);
  }

  /** 部屋にいない人のカーソルを消す。消した識別子を返す */
  private removeStrayCursors(): string[] {
    const here = new Set(this.seats().map(({ seat }) => seat.peerId));
    return this.store
      .owners()
      .filter((owner) => !here.has(owner))
      .flatMap((owner) => this.store.removeOwnedBy(owner));
  }

  /** 消したカーソルを、持っている人に消させる。exclude（入ってきたばかりの人）は持っていない */
  private dropCursors(identifiers: string[], exclude?: C): void {
    if (identifiers.length === 0) return;
    this.scheduleFlush();
    const events = identifiers.map((identifier) =>
      fromAuthority(SyncEvent.DELETE, { aliasName: PEER_CURSOR_ALIAS, identifier })
    );
    this.broadcast(exclude, { type: 'data', from: AUTHORITY_PEER_ID, events });
  }

  closed(conn: C): void {
    if (this.gone.has(conn)) return;
    this.gone.add(conn);
    const seat = this.host.seatOf(conn);
    if (seat && !seat.closed) this.leave(seat);
  }

  /** その人が出た。その人のあいだだけ置いていたものを消し、ほかの人に知らせる */
  private leave(seat: Seat): void {
    if (this.store.removeOwnedBy(seat.peerId).length > 0) this.scheduleFlush();
    this.broadcast(undefined, { type: 'leave', peerId: seat.peerId });
    if (this.seats().length === 0) this.host.emptied();
    this.host.lobbyChanged(seat.roomKey);
    this.host.record('leave', seat.role, (Date.now() - seat.joinedAt) / 1000);
  }

  /** 理由を送ってから閉じる。入っていた人なら、出たことにする */
  private refuse(conn: C, code: ErrorCode): void {
    const seat = this.host.seatOf(conn);
    this.refused.add(conn);
    if (seat && !seat.closed) {
      this.host.setSeat(conn, { ...seat, closed: true });
      if (code !== 'replaced') this.leave(seat);
    }
    this.post(conn, { type: 'error', code, protocolVersion: PROTOCOL_VERSION });
    this.host.record('refuse', code, 1);
    this.host.close(conn, CLOSE_CODE, code);
  }

  /** 入っている人。exclude を除く */
  seats(exclude?: C): { conn: C; seat: Seat }[] {
    return this.host.connections().flatMap((conn) => {
      const seat = this.host.seatOf(conn);
      return conn !== exclude && seat && !seat.closed && !this.gone.has(conn) ? [{ conn, seat }] : [];
    });
  }

  private rateOf(conn: C): { start: number; count: number; events: number; rolls: number } {
    const now = Date.now();
    let rate = this.rates.get(conn);
    if (!rate || now - rate.start >= RATE_WINDOW_MS) {
      rate = { start: now, count: 0, events: 0, rolls: 0 };
      this.rates.set(conn, rate);
    }
    return rate;
  }

  private withinRate(conn: C): boolean {
    const rate = this.rateOf(conn);
    rate.count += 1;
    return rate.count <= MAX_FRAMES_PER_WINDOW;
  }

  /** 送ってきたイベントの数が上限のうちか。1つのフレームに詰めたものも1つずつ数える */
  private withinEvents(conn: C, count: number): boolean {
    const rate = this.rateOf(conn);
    rate.events += count;
    return rate.events <= MAX_EVENTS_PER_WINDOW;
  }

  /** ダイスを頼める数のうちか */
  private withinRolls(conn: C): boolean {
    const rate = this.rateOf(conn);
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
  private relay(sender: C, seat: Seat, to: string | undefined, events: { eventName: string; data: unknown }[]): void {
    const others = this.seats(sender);
    const target = to === undefined ? undefined : others.find((other) => other.seat.peerId === to);
    const forAuthority = to === undefined || to === AUTHORITY_PEER_ID;
    const outbox = new Map<C, EventContext[]>();
    const push: Push<C> = (conn, event) => {
      const list = outbox.get(conn) ?? [];
      list.push(event);
      outbox.set(conn, list);
    };
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));

    for (const { eventName, data } of events) {
      const event: EventContext = { eventName, data, sendFrom: seat.peerId };
      const toAddressee = () => {
        if (to === undefined) for (const other of others) push(other.conn, event);
        else if (target) push(target.conn, event);
      };
      // サーバーだけが送るものは、クライアントから来ても届けない
      if (AUTHORITY_ONLY_EVENTS.includes(eventName)) continue;
      switch (eventName) {
        case SyncEvent.UPDATE:
          this.update(data, seat, sender, push);
          break;
        case SyncEvent.DELETE:
          this.remove(event, seat, sender, push);
          break;
        case SyncEvent.FORGET_DELETED:
          if (this.forget(data, seat)) for (const other of others) push(other.conn, event);
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

    this.deliver(outbox, (conn) => (conn === sender ? AUTHORITY_PEER_ID : seat.peerId));
    if (this.store.hasPending) this.scheduleFlush();
  }

  /**
   * 受け取る人ごとの束を送る。同じ並びのイベントを受け取る人たちには、1度だけ符号にして送る
   */
  private deliver(outbox: Map<C, EventContext[]>, fromOf: (conn: C) => string): void {
    const ids = new Map<EventContext, number>();
    const frames = new Map<string, Uint8Array>();
    for (const [conn, events] of outbox) {
      const from = fromOf(conn);
      const key = `${from}:${events.map((event) => ids.get(event) ?? ids.set(event, ids.size).get(event)).join(',')}`;
      let frame = frames.get(key);
      if (!frame) {
        frame = encodeFrame({ type: 'data', from, events });
        frames.set(key, frame);
      }
      this.sendFrame(conn, frame);
    }
  }

  /**
   * UPDATE を状態に当て、見てよい人へ見てよい形で配る。
   *
   * 送り主から見えないものには書かせない（WITHDRAW を返す）。伏せた形で持っている人が書き戻して
   * きたら、伏せたところを置いてある中身に戻す。PeerCursor の役割は、その人の席の役割で上書きする。
   * 見学者は、自分のカーソルと、見学者も話せるタブへの発言しか書けない。
   */
  private update(data: unknown, seat: Seat, sender: C, push: Push<C>): void {
    const parsed = safeParse(objectContextSchema, data);
    if (!parsed.success) return;
    let context = parsed.output;
    const { identifier, aliasName } = context;
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));

    // 置いてあるものの種類は変えさせない。カーソルを名乗って、ほかのものを上書きさせないため
    const existing = this.store.entryOf(identifier);
    if (existing && existing.alias !== aliasName) return this.refuseWrite(identifier, seat, reply);
    // 大きすぎる見え方の手がかりは、索引にも置き場所の1行にも置けない。新しいものは数も絞る。版を一度に
    // 大きく跳ばさせない
    if (
      !fitsIndex(context) ||
      (!existing && this.store.size >= MAX_OBJECTS) ||
      context.majorVersion > (existing?.majorVersion ?? 0) + MAX_VERSION_STEP
    )
      return this.refuseWrite(identifier, seat, reply);

    const seen = this.kindOf(identifier, seat);
    if (seen === 'hidden') return reply(AuthorityEvent.WITHDRAW, { identifier });
    if (seen === 'masked') context = unmasked(context, this.store.get(identifier) as ObjectContext);
    if (
      existing &&
      seat.role !== 'gm' &&
      (!mayChangeView(existing.view, describe(context).view, seat) ||
        this.uncovers(context, existing, seat) ||
        movesTab(existing, context))
    )
      return this.refuseWrite(identifier, seat, reply);

    let owner: string | null = null;
    // 伏せた形で持っている人には、受けたあとも伏せた形（伏せた版）を持たせる。見えるようになったときに
    // 版の違いで取り直せるように
    let corrected = seen === 'masked';
    if (aliasName === PEER_CURSOR_ALIAS) {
      // カーソルを書けるのは、その人だけ。ほかの人のユーザー ID を書き込めば、その人あての秘話や
      // 配られるカードが、書いた人に向いてしまう
      const named = String(context.syncData.peerId);
      if (existing ? existing.owner !== seat.peerId : named !== seat.peerId) {
        if (existing || this.seats().some((other) => other.seat.peerId === named))
          return this.refuseWrite(identifier, seat, reply);
        // 出ていった人のカーソルは置かない。クライアントは leave を受けて自分で片付ける
        return;
      }
      owner = seat.peerId;
      const fixed = { peerId: seat.peerId, userId: seat.userId, role: seat.role };
      if (Object.entries(fixed).some(([field, value]) => context.syncData[field] !== value)) {
        context = { ...context, syncData: { ...context.syncData, ...fixed } };
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
      owner === null && this.store.isDeleted(identifier)
    );
    if (verdict === 'stale') {
      const view = this.viewOf(identifier, seat);
      // まだ見え方の決まらないもの（親が未着）は、中身を返せないので手元から外させる
      if (!view) return this.refuseWrite(identifier, seat, reply);
      // 伏せた形には本物より小さい版を付けるので、送り主の版より低いことがある。そのときは UPDATE では
      // 捨てられ、負けた変更がその人の画面にだけ残るので、版にかかわらず置き換えさせる
      reply(seen === 'masked' ? AuthorityEvent.AUTHORITATIVE : SyncEvent.UPDATE, view);
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
      existing.view?.kind === 'data' && next.view?.kind === 'data' && existing.view.name !== next.view.name;
    if (next.parent === existing.parent && !renamed) return false;
    const identifier = context.identifier;
    // 比べるのは道筋の変化だけ。カードの向きや手札などの状態は mayChangeView が確かめているので、
    // 前のままにして比べる（山札から引いて自分の手札に入れると、親も変わるのに表は見えて正しい）
    const moved = {
      parent: next.parent,
      view: next.view?.kind === 'data' ? next.view : existing.view,
    };
    const after: Lookup = (other) => (other === identifier ? { ...existing, ...moved } : this.store.lookup(other));
    // まだ無い親の下は、親が来たときにどう見えるかわからない。いちばん見える場合として比べる
    const eventual = (kind: ViewKind): ViewKind => (kind === 'pending' ? 'full' : kind);
    return [identifier, ...this.store.dependentsOf(identifier)].some((other) =>
      looser(eventual(this.kindOf(other, seat, after)), eventual(this.kindOf(other, seat)))
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
    sender: C,
    push: Push<C>,
    corrected: boolean
  ): void {
    const { identifier } = context;
    const was: Lookup = (other) => (other === identifier ? before : this.store.lookup(other));
    for (const { conn, seat: other } of this.seats(sender)) {
      const then = before ? this.kindOf(identifier, other, was) : 'hidden';
      const now = this.kindOf(identifier, other);
      if (delivered(now)) {
        push(conn, {
          eventName: SyncEvent.UPDATE,
          data: viewFor(context, now),
          sendFrom: seat.peerId,
        });
      } else if (delivered(then)) {
        push(conn, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
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
    if (!before || before.parent !== after.parent || JSON.stringify(before.view) !== JSON.stringify(after.view)) {
      this.revisit(this.store.dependentsOf(identifier), this.seats(), was, push, sender);
    }
  }

  /**
   * 見え方の決まるもとが変わったので、そのものの見え方を人ごとに比べ直す。見えるようになった人には
   * AUTHORITATIVE_OBJECT で渡し（版が同じでも置き換わる）、見えなくなった人には WITHDRAW で外させる。
   *
   * 親を待っていたもの（pending）が見えるようになったとき、writer には渡さない。親を待つ子を作れるのは、
   * その親を持っている人（親を送ってきた本人）だけなので、writer はもう持っている。ただし、親を待つ
   * あいだにカタログで外させたものは、writer にも渡す
   */
  private revisit(
    identifiers: string[],
    seats: { conn: C; seat: Viewer }[],
    was: Lookup,
    push: Push<C>,
    writer?: C
  ): void {
    for (const { conn, seat } of seats) {
      for (const identifier of identifiers) {
        const then = viewKind(identifier, seat, was);
        const now = viewKind(identifier, seat, this.store.lookup);
        const withdrawn = then === 'pending' && !!this.withdrawnPending.get(seat.userId)?.has(identifier);
        if (conn === writer && then === 'pending' && !withdrawn) continue;
        this.resend(conn, identifier, then, now, push);
        // 親がもう1段届いていないうちは、まだ渡していないので覚えておく
        if (withdrawn && now !== 'pending') this.withdrawnPending.get(seat.userId)?.delete(identifier);
      }
    }
  }

  /** 見え方が then から now に変わったものを、その人に渡すか外させる。変わらなければ何もしない */
  private resend(conn: C, identifier: string, then: ViewKind, now: ViewKind, push: Push<C>): void {
    if (then === now) return;
    if (!delivered(now)) {
      if (delivered(then)) push(conn, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
      return;
    }
    const context = this.store.get(identifier) as ObjectContext;
    push(conn, fromAuthority(AuthorityEvent.AUTHORITATIVE, viewFor(context, now)));
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
          attributes: Object.fromEntries(Object.entries(attributes).filter(([field]) => field !== SERVER_ROLL_FIELD)),
        },
      };
    }
    const original = attributesOf(stored);
    const disclosed =
      (original.originFrom === seat.userId || seat.role === 'gm') && isDisclosureOf(original.tag, attributes.tag);
    // 公開した行は末尾へ移る（Axe の discloseMessage）。時刻は遠い過去へずらさせず、並びの位置は
    // 端数だけ受ける
    const kept = disclosed
      ? {
          ...original,
          tag: attributes.tag,
          disclosedAt: attributes.disclosedAt === undefined ? undefined : notLongAgo(attributes.disclosedAt),
        }
      : original;
    const place = disclosed
      ? {
          majorIndex: stored.syncData.majorIndex,
          minorIndex: indexFraction(context.syncData.minorIndex),
        }
      : stored.syncData;
    const guarded = seat.role === 'gm' ? ROLLED_ATTRIBUTES : [...ROLLED_ATTRIBUTES, ...ROLLED_GM_ATTRIBUTES];
    const changed =
      context.syncData.value !== stored.syncData.value ||
      context.syncData.parentIdentifier !== stored.syncData.parentIdentifier ||
      ROLLED_PLACE.some((field) => context.syncData[field] !== place[field]) ||
      guarded.some((field) => attributes[field] !== kept[field]);
    if (!changed) return context;
    // 元の発言に無かった項目は、undefined を置かずに外す（MessagePack では null になって届く）
    const restored = Object.fromEntries(Object.entries(attributes).filter(([field]) => !guarded.includes(field)));
    for (const field of guarded) if (kept[field] !== undefined) restored[field] = kept[field];
    const syncData = Object.fromEntries(
      Object.entries(context.syncData).filter(
        ([field]) => field !== 'parentIdentifier' && !ROLLED_PLACE.includes(field)
      )
    );
    // 振った結果には、並びの位置をいつも置いてある
    for (const field of ROLLED_PLACE) syncData[field] = place[field];
    // 振った結果は、タブの一覧の直下のタブにしか置かない
    syncData.parentIdentifier = stored.syncData.parentIdentifier;
    return {
      ...context,
      syncData: { ...syncData, value: stored.syncData.value, attributes: restored },
    };
  }

  /**
   * ダイスを振り、結果の発言を作って配る。頼まれた順に振り、システムを初めて使うときだけ読み込みを待つ。
   * コマンドでなければ何もしない。見学者は、自分が発言できるタブでだけ振れる。
   * 結果は見てよい人へ見てよい形で配る（秘話の宛先、シークレットなら伏せた形）
   */
  private requestRoll(data: unknown, seat: Seat, sender: C): void {
    const parsed = safeParse(rollRequestSchema, data);
    const reject = (identifier: unknown, reason: RollRejectReason) => {
      if (typeof identifier !== 'string') return;
      this.post(sender, {
        type: 'data',
        from: AUTHORITY_PEER_ID,
        events: [fromAuthority(AuthorityEvent.ROLL_REJECTED, { identifier, reason })],
      });
    };
    if (!parsed.success) {
      const message = (data as { message?: { identifier?: unknown } } | null)?.message;
      return reject(message?.identifier, 'invalid');
    }
    const request = parsed.output;
    const { message } = request;
    // 同じものを頼み直されたとき（つなぎ直したあとなど）は、もう振ってあるので何も返さない
    if (this.store.entryOf(message.identifier) || this.store.isDeleted(message.identifier)) return;
    if (
      message.aliasName !== CHAT_MESSAGE_ALIAS ||
      !fitsIndex(message) ||
      message.majorVersion > MAX_VERSION_STEP ||
      this.store.size >= MAX_OBJECTS ||
      !this.isListedTab(String(message.syncData.parentIdentifier ?? ''))
    ) {
      return reject(message.identifier, 'invalid');
    }
    if (seat.role === 'guest' && !this.guestMayWrite(message, seat)) {
      return reject(message.identifier, 'not-allowed');
    }
    // 振るのは重いので、頼める数を絞る。超えたものは振らない
    if (!this.withinRolls(sender)) return reject(message.identifier, 'rate-limited');
    if (this.pendingRolls >= MAX_PENDING_ROLLS) return reject(message.identifier, 'busy');

    this.pendingRolls += 1;
    this.rollQueue = this.rollQueue
      .then(async () => {
        // 1つ振るごとに、ほかのメッセージに順番を譲る
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = Date.now();
        const rolled = await rollLine(request.gameSystem, request.command);
        // 振っているあいだに部屋が削除されていたら、置く先が無い
        if (!this.host.room()) return;
        this.host.record('roll', request.gameSystem, Date.now() - started);
        // 振っているあいだに、同じ識別子のものが置かれていたら作らない
        const taken = this.store.entryOf(message.identifier) || this.store.isDeleted(message.identifier);
        if (taken) return;
        if (!rolled) return reject(message.identifier, 'not-a-command');
        // 振っているあいだにタブが消されたり移されたりしていたら、置く先が無い
        if (!this.isListedTab(String(message.syncData.parentIdentifier))) return reject(message.identifier, 'invalid');
        // 文面は syncData.value、そのほかは ChatMessage の SyncVar なので attributes に入れる。並びの位置は
        // 頼まれたタブの中の端数だけ受け、頼んだ人が足した飾りや印は外す
        const result = withAttributes(
          {
            ...message,
            syncData: {
              ...message.syncData,
              value: `${rolled.text}${request.suffix ?? ''}`,
              majorIndex: 0,
              minorIndex: indexFraction(message.syncData.minorIndex),
              attributes: neutralRollAttributes(attributesOf(message)),
            },
          },
          {
            dicebot: rolled.dicebot,
            tag: rolled.secret ? 'system secret' : 'system',
            name: rolled.secret ? `<Secret-BCDice：${request.speaker}>` : `<BCDice：${request.speaker}>`,
            from: DICE_BOT_SENDER,
            originFrom: seat.userId,
            // 頼んだ人の時刻は、遠い過去にずらして並びの奥へ埋めさせない
            timestamp: notLongAgo(attributesOf(message).timestamp),
            [SERVER_ROLL_FIELD]: true,
          }
        );
        this.store.put(result, null);
        this.scheduleFlush();
        for (const { conn, seat: other } of this.seats()) {
          const view = viewFor(result, this.kindOf(result.identifier, other));
          if (view) {
            this.post(conn, {
              type: 'data',
              from: AUTHORITY_PEER_ID,
              events: [fromAuthority(SyncEvent.UPDATE, view)],
            });
          }
        }
      })
      .catch((err: unknown) => {
        console.error('Roll failed:', err);
        reject(message.identifier, 'failed');
      })
      .finally(() => {
        this.pendingRolls -= 1;
      });
    this.host.defer(this.rollQueue);
  }

  /**
   * 書く権限の無い変更を、送り主の手元で戻させる。サーバーが持っていればその人に見せる形に戻し、
   * 消したものなら消させ、どちらでもなければ（新しく作ろうとしたもの）印を残さずに取り下げさせる
   */
  private refuseWrite(identifier: string, seat: Seat, reply: Reply): void {
    const view = this.viewOf(identifier, seat);
    if (view) reply(AuthorityEvent.AUTHORITATIVE, view);
    else if (this.store.isDeleted(identifier)) reply(SyncEvent.DELETE, { aliasName: '', identifier });
    else reply(AuthorityEvent.WITHDRAW, { identifier });
  }

  /**
   * DELETE を状態に当てる。見学者が消せるのは自分のカーソルだけ。見えないものは消させない。
   *
   * 消したものの子孫も一緒に消す。送り主から見えなかった子孫（裏向きのカードの表など）は、送り主の
   * 手元に無いので送り主からは消しに来ない。持っている人には、サーバーから DELETE を送る
   */
  private remove(event: EventContext, seat: Seat, sender: C, push: Push<C>): void {
    const parsed = safeParse(deleteSchema, event.data);
    if (!parsed.success) return;
    const { aliasName, identifier } = parsed.output;
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));
    const entry = this.store.entryOf(identifier);
    // 子孫として、もう消してある
    if (!entry && this.store.isDeleted(identifier)) return;
    if (this.kindOf(identifier, seat) === 'hidden') return;
    const owner = entry?.owner ?? null;
    // その人のあいだだけ置くもの（カーソル）は、その人だけが消せる
    if ((owner !== null || seat.role === 'guest') && owner !== seat.peerId)
      return this.refuseWrite(identifier, seat, reply);
    const kept = this.keptFromDeleting.get(seat.peerId);
    // 見えないものは上で外れ、残るものは親のそろった子孫なので、送り主に届いている
    if (kept && kept.until > Date.now() && kept.ids.has(identifier)) return this.refuseWrite(identifier, seat, reply);
    const doomed = [identifier, ...this.store.descendantsOf(identifier)];
    // サーバーが振った結果は、GM のほかには消させない。タブごと消すのも同じ。送り主の手元からは消えて
    // いるので、見えるものを全部返す。続けて送られてくる中の行も、しばらく消させない
    if (seat.role !== 'gm' && doomed.some((id) => this.isServerRoll(id))) {
      for (const id of doomed) {
        if (delivered(this.kindOf(id, seat))) this.refuseWrite(id, seat, reply);
      }
      const ids = kept && kept.until > Date.now() ? kept.ids : new Set<string>();
      for (const id of doomed) ids.add(id);
      this.keptFromDeleting.set(seat.peerId, { ids, until: Date.now() + KEEP_FROM_DELETING_MS });
      return;
    }
    const others = this.seats(sender);
    const seen = new Map(others.map(({ conn, seat: other }) => [conn, doomed.map((id) => this.kindOf(id, other))]));
    // 印を残すかは、置いてあるものの種類で決める。送られてきた種類を信じると、カーソルを名乗って
    // 何でも印を残さずに消せ、古い写しを持つ人から戻ってきてしまう
    const cursor = entry ? entry.alias === PEER_CURSOR_ALIAS : aliasName === PEER_CURSOR_ALIAS;
    for (const id of doomed) this.store.delete(id, !cursor);
    for (const { conn } of others) {
      doomed.forEach((id, index) => {
        if (!delivered((seen.get(conn) as ViewKind[])[index])) return;
        push(conn, id === identifier ? event : fromAuthority(SyncEvent.DELETE, { aliasName: '', identifier: id }));
      });
    }
  }

  /** チャットのタブの一覧の直下にある、みんなのタブか。振った結果はそこにだけ置く */
  private isListedTab(identifier: string): boolean {
    const tab = this.store.entryOf(identifier);
    return tab?.alias === CHAT_TAB_ALIAS && tab.parent === CHAT_TAB_LIST_IDENTIFIER;
  }

  private isServerRoll(identifier: string): boolean {
    const stored = this.store.entryOf(identifier)?.alias === CHAT_MESSAGE_ALIAS && this.store.get(identifier);
    return stored ? attributesOf(stored)[SERVER_ROLL_FIELD] === true : false;
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
    const reject = (reason: RoleRejectReason) => reply(AuthorityEvent.ROLE_REJECTED, { peerId, role, reason });
    if (seat.role !== 'gm') return reject('not-game-master');
    const target = this.seats().find((other) => other.seat.peerId === peerId)?.seat;
    if (!target) return reject('unknown-peer');
    if (!target.account) return reject('not-logged-in');
    const gameMasters = this.host.roles.gameMasterCount();
    if (target.role === 'gm' && role !== 'gm' && gameMasters <= 1) return reject('last-game-master');

    this.host.roles.set(target.userId, role);
    this.host.lobbyChanged(seat.roomKey);
    const outbox = new Map<C, EventContext[]>();
    const push: Push<C> = (conn, event) => outbox.set(conn, [...(outbox.get(conn) ?? []), event]);
    const updates: EventContext[] = [];
    for (const { conn, seat: other } of this.seats()) {
      if (other.userId !== target.userId) continue;
      this.host.setSeat(conn, { ...other, role });
      // すべてのものを、前の役割と今の役割で見比べる
      for (const identifier of this.store.identifiers()) {
        this.resend(
          conn,
          identifier,
          this.kindOf(identifier, other),
          this.kindOf(identifier, { ...other, role }),
          push
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
    for (const { conn } of this.seats()) for (const update of updates) push(conn, update);
    this.deliver(outbox, () => AUTHORITY_PEER_ID);
    // アセットを置けるかは役割で決まるので、新しい役割のトークンに替えさせる
    for (const { conn, seat: other } of this.seats()) {
      if (other.userId !== target.userId) continue;
      this.post(conn, { type: 'asset-token', ...this.assetTokenFor(other, 'expiresAt'), role });
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
      // 見え方の決まらないもの（親が未着）も、決まるまで外させる。決まって見えるようになれば渡す
      const kind = this.kindOf(identifier, seat);
      if (kind === 'hidden' || (kind === 'pending' && seat.role !== 'gm')) {
        reply(AuthorityEvent.WITHDRAW, { identifier });
        if (kind === 'pending') {
          const withdrawn = this.withdrawnPending.get(seat.userId) ?? new Set<string>();
          this.withdrawnPending.set(seat.userId, withdrawn.add(identifier));
        }
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

  private post(conn: C, message: ServerMessage): void {
    this.sendFrame(conn, encodeFrame(message));
  }

  private broadcast(exclude: C | undefined, message: ServerMessage): void {
    const frame = encodeFrame(message);
    for (const { conn } of this.seats(exclude)) this.sendFrame(conn, frame);
  }

  private sendFrame(conn: C, frame: Uint8Array): void {
    this.host.send(conn, frame);
  }

  // ---- 置き場所 ----

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => this.flushNow(), FLUSH_DELAY_MS);
  }

  /**
   * まとめておいた変更を、待たずに書く。部屋のサーバーが部屋を放す前（Vercel 版で、最後の1人が出たとき）にも
   * 呼ぶ。書いた数は、間を置いてまとめて記録する
   */
  flushNow(): void {
    this.stopFlushing();
    const now = Date.now();
    if (this.flushTally.count === 0) this.flushTally.since = now;
    this.flushTally.count += this.store.flush();
    if (now - this.flushTally.since >= FLUSH_TALLY_MS || this.seats().length === 0) {
      this.host.record('flush', '', this.flushTally.count);
      this.flushTally = { count: 0, since: now };
    }
  }
}
