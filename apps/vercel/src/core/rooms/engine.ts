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
  HANDED_BACK_MS,
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
import { MAX_DEPTH, delivered, describe, looser, maskedMinor, unmasked, viewFor, viewKind } from './visibility.js';
import type { Lookup, ViewKind, Viewer } from './visibility.js';

type Reply = (eventName: string, data: unknown) => void;

/** The alias of a deck, whose cards keep their faces from everyone. */
const CARD_STACK_ALIAS = 'card-stack';

/** What the deck check reads of an index row: what the object is, where it sits and how it is seen. */
type DeckRow = Pick<StoredEntry, 'alias' | 'parent' | 'view'>;

/** Adds one event to the bundle for one receiver. */
type Push<C> = (conn: C, event: EventContext) => void;

/**
 * Relay and sync for one room. It reads what comes in on the connections of those in the room,
 * applies it to the room's state, and sends it out to those who may see it, in the form they may
 * see.
 *
 * To the clients it looks like a special peer that holds everything (AUTHORITY_PEER_ID). Catalogs
 * are traded with this peer alone, and UPDATE and DELETE are put through LWW here before they are
 * sent out.
 *
 * The connections, seats, the room's row, roles and the store belong to RoomHost. So that it works
 * the same on every room server (Cloudflare's Durable Object, the room's owner on Vercel), this
 * runs synchronously, within one flow of one room. No await comes between checking and writing.
 * Only what does no harm when lost is kept in memory (the counts for sending too much, how many
 * rolls are waiting, and what may not be deleted for a while).
 */
export class RoomEngine<C extends object> {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many written changes are not logged yet, and when counting began. */
  private flushTally = { count: 0, since: 0 };
  /** Rolls go in the order they were asked for. It waits only when a system is loaded the first time. */
  private rollQueue: Promise<void> = Promise.resolve();
  /** The frames, events and dice each connection has sent: when the window began, and the counts since. */
  private readonly rates = new WeakMap<C, { start: number; count: number; events: number; rolls: number }>();
  /** The connections reported as dropped. */
  private readonly gone = new WeakSet<C>();
  /** The connections refused and closed. One refused before its hello has no seat, so it is remembered here. */
  private readonly refused = new WeakSet<C>();
  /** When a connection before its hello was taken in. One with no time here counts as having waited too long. */
  private readonly connectedAt = new WeakMap<C, number>();
  /** How many dice are waiting to be rolled. */
  private pendingRolls = 0;
  /**
   * For each user id, what a catalog had taken back while it waited for its parent. Even the one who
   * wrote it no longer has it, so it is handed over once the parent comes and it can be seen. A
   * reconnected seat is the same person, so this is kept by user id, not by connection.
   */
  private withdrawnPending = new Map<string, Set<string>>();
  /** For each seat, what it was kept from deleting along with the descendants, and until when that lasts. */
  private keptFromDeleting = new Map<string, { ids: Set<string>; until: number }>();
  /**
   * Waits for the last of what is kept from deleting to be let go. A timer waiting keeps the room
   * from hibernating, which would lose what is kept between the steps a seat paces its deletes in.
   */
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * For each seat, what was handed back to it as it stands, and until when that is minded. A deletion
   * of one that goes through is told back to the seat, which may have made it again on taking it
   * back after sending the deletion.
   */
  private handedBack = new Map<string, { ids: Set<string>; until: number }>();
  /**
   * For each seat, what it was told had gone on deleting it. One the seat then makes again, as on
   * loading a room or undoing, is handed to it once more: it made it before the word came, however
   * long the load in between. It lasts until then, or until the seat leaves.
   */
  private toldGone = new Map<string, Set<string>>();
  /**
   * Who wrote what waits for its parent. It is handed to the one who sends the parent once the
   * parent comes, unless that one wrote it: a line said into a tab while it was deleted reaches the
   * one who brings the tab back only so.
   */
  private pendingWriters = new Map<string, string>();

  constructor(private readonly host: RoomHost<C>) {}

  private get store(): RoomStore {
    return this.host.store();
  }

  /**
   * Accepts a connection. Even when there is no room or it is full, the connection is accepted, then
   * sent the reason and closed. Refused over HTTP before it is accepted, the browser cannot read the
   * reason and learns only that it did not connect.
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
   * The room has been deleted, so sends room-deleted to those in it and then closes them. They are
   * not treated as having left (there is nobody left to tell, and no room left to write it in).
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

  /**
   * Deletes the cursors of those not in the room, and has those who hold them delete them too. It
   * cleans up after the room server has gone down.
   */
  dropStrayCursors(): void {
    this.dropCursors(this.removeStrayCursors());
  }

  private noteHandedBack(peerId: string, identifier: string): void {
    const handed = this.handedBackTo(peerId) ?? { ids: new Set<string>(), until: 0 };
    handed.ids.add(identifier);
    handed.until = Date.now() + HANDED_BACK_MS;
    this.handedBack.set(peerId, handed);
  }

  /** What was handed back to the seat, while it is still minded. */
  private handedBackTo(peerId: string): { ids: Set<string>; until: number } | undefined {
    const handed = this.handedBack.get(peerId);
    if (handed && handed.until <= Date.now()) this.handedBack.delete(peerId);
    return this.handedBack.get(peerId);
  }

  /** Whether the seat makes again what it was told had gone, which is then handed to it once more. */
  private madeAgain(peerId: string, identifier: string): boolean {
    return this.toldGone.get(peerId)?.delete(identifier) ?? false;
  }

  /** Keeps the room awake until the last of what is kept from deleting is let go. */
  private keepAwake(): void {
    if (this.keepTimer !== null) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    const untils = [...this.keptFromDeleting.values()].map((kept) => kept.until);
    if (untils.length === 0) return;
    this.keepTimer = setTimeout(this.letKeepGo, Math.max(0, Math.max(...untils) - Date.now()));
  }

  /** Lets go of what is kept from deleting once its time is up, staying awake for the rest. */
  private readonly letKeepGo = (): void => {
    this.keepTimer = null;
    const now = Date.now();
    for (const [peerId, kept] of this.keptFromDeleting) {
      if (kept.until <= now) this.keptFromDeleting.delete(peerId);
    }
    this.keepAwake();
  };

  /** Stops writing changes in batches. It is for when the room is deleted. */
  stopFlushing(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /**
   * Whether someone putting an asset still has a role in this room that may put one (GM or player).
   * The asset PUT asks it. A token lasts 15 minutes, so it is refused if the room has gone or the
   * seat has been made a guest in that time.
   */
  canUpload(userId: string): 'ok' | 'room-not-found' | 'not-a-player' {
    if (this.host.wiping() || !this.host.room()) return 'room-not-found';
    // Only while seated. Someone who has left cannot put one, even with a token still left.
    const seated = this.seats().some(
      ({ seat }) => seat.account && seat.userId === userId && (seat.role === 'gm' || seat.role === 'pl')
    );
    return seated ? 'ok' : 'not-a-player';
  }

  /**
   * Closes the connections that have gone past HELLO_TIMEOUT_MS without sending a hello. Left open,
   * connections that never send a hello could fill the room.
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
   * Removes the seats whose access token ran out more than TOKEN_GRACE_MS ago with no new token
   * since. This is so that someone who logged out or deleted their account does not stay connected
   * and keep watching.
   */
  expireSeats(): void {
    const now = Date.now();
    for (const { conn, seat } of this.seats()) {
      if (seat.expiresAt !== undefined && now > seat.expiresAt + TOKEN_GRACE_MS) {
        this.refuse(conn, 'unauthorized');
      }
    }
  }

  /**
   * Counts a ping a socket on another instance sent on to this one, as any frame is counted; over
   * the limit, the connection is closed as for any frame. Answers whether the ping is to be answered.
   */
  takeRelayedPing(conn: C): boolean {
    if (this.refused.has(conn)) return false;
    if (this.withinRate(conn)) return true;
    this.refuse(conn, 'too-many-messages');
    return false;
  }

  /** Takes in what came on a connection. */
  receive(conn: C, message: string | ArrayBuffer | Uint8Array): void {
    // The room server answers PING itself, so text that reaches here is of no use. Dropped silently,
    // it could keep waking the room without being counted, so it is refused and closed.
    if (typeof message === 'string') return this.refuse(conn, 'bad-message');
    this.expireSeats();
    const seat = this.host.seatOf(conn);
    if (seat?.closed || this.refused.has(conn)) return;
    // Nothing that comes while the room is being deleted is taken in (no seat is made, and no token
    // is handed out again).
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
    // A hello after coming in does nothing.
  }

  // ---- Coming in and leaving ----

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

    // Not logged in, it is a guest. Logged in, the userId must be that of the one the token is for.
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
      // A logged-in person's user id may not be claimed without a token (it would show what that
      // person can see). There are accounts of the older shape, without the prefix, so accounts that
      // have been in this room are checked too.
      return this.refuse(conn, 'unauthorized');
    }
    // The names used as the sender of messages (the dice bot and others) may not be claimed. Such a
    // seat would be taken for the sender of the messages the server rolled, and see secrets and
    // whispers.
    if (RESERVED_USER_IDS.has(hello.userId)) return this.refuse(conn, 'bad-message');
    // Nobody may claim someone else's peer id. If they could, they could take the seat while that
    // person was away and lock them out when they came back.
    if (!mayClaimPeerId(hello.userId, hello.peerId)) return this.refuse(conn, 'bad-message');
    if (hello.accessToken) {
      const secret = this.host.sessionSecret();
      const claims = secret ? readToken(hello.accessToken, 'access', secret) : null;
      if (!secret || !claims || claims.uid !== hello.userId) return this.refuse(conn, 'unauthorized');
      const { role, known } = this.roleOf(hello.userId, hello.invite ?? null, room.roomKey, secret);
      seat.role = role;
      seat.account = true;
      seat.expiresAt = claims.exp * 1000;
      // The role is remembered only when the seat is taken. The invite of someone refused still works
      // the next time they come in.
      if (this.seat(conn, seat) && !known) {
        this.host.roles.add(hello.userId, role);
      }
      return;
    }
    this.seat(conn, seat);
  }

  /**
   * The role of someone logged in: the role they had if they have been in before, the invite's role
   * on a first visit, and player when there is no invite or it is not for this room. known says
   * whether they have been in before.
   * A GM invite counts as none when whoever gave it is no longer GM. An invite given earlier by
   * someone who has since been removed as GM may not add GMs. The seat row of someone who deleted
   * their account stays in the room, so their invite still works as a GM's.
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
   * A token to read and write this room's assets, and when it runs out (Unix milliseconds). The time
   * comes back under the name in expiresAt (welcome and asset-token name it differently). The role
   * goes in the token, so that only the GM and players can put assets.
   */
  /**
   * How assets are put. A room server that takes them with a PUT alone (the Cloudflare version)
   * leaves it out of welcome.
   */
  private uploadPolicy(): { assetUpload?: AssetUploadPolicy } {
    const policy = this.host.assetUploadPolicy();
    return policy ? { assetUpload: policy } : {};
  }

  private assetTokenFor<K extends string>(seat: Seat, expiresAt: K): { assetToken: string } & Record<K, number> {
    const secret = this.host.sessionSecret();
    // On a room server running without login, the asset routes take no token either, so it is left
    // empty.
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

  /**
   * Makes an invite when a GM asks for one. For someone who is not GM, or on a room server running
   * without login, it answers with a null invite.
   */
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
   * Takes a new access token while the connection stays open. When it is the same person's, the
   * seat's expiry is pushed back; otherwise the seat is removed. A guest's seat has no expiry, so
   * taking one does nothing.
   */
  private renew(conn: C, seat: Seat, accessToken: string): void {
    if (!seat.account) return;
    const claims = readToken(accessToken, 'access', this.host.sessionSecret() ?? '');
    if (!claims || claims.uid !== seat.userId) return this.refuse(conn, 'unauthorized');
    this.host.setSeat(conn, { ...seat, expiresAt: claims.exp * 1000 });
  }

  /** Seats a connection. True when it is seated, false when it is refused. */
  private seat(conn: C, seat: Seat): boolean {
    let others = this.seats(conn);
    let previous = others.find((other) => other.seat.peerId === seat.peerId);
    if (previous && !isSamePerson(previous.seat, seat)) {
      // One claiming someone else's peer id is not let in. Let in, it could push that person out and
      // take their place. But when a guest got a logged-in person's peer id first, the guest is the
      // one removed. A peer id is made from the user id, so only the logged-in person can have their
      // peer id.
      if (previous.seat.account || !seat.account) {
        this.refuse(conn, 'bad-message');
        return false;
      }
      this.refuse(previous.conn, 'bad-message');
      others = this.seats(conn);
      previous = undefined;
    }
    if (seat.account) {
      // A guest that claimed the logged-in person's user id without a token is removed. The view
      // follows the user id, so if the guest stayed, that person's hand and whispers would reach it
      // too.
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
      // The same person has reconnected. The old connection is one already cut that still lingers.
      // Its cursor is kept: the same page comes back with it as it was, as on a server asking the
      // seat back on another link, and others would see it go and come back. A reloaded page's
      // cursor has another identifier, and the old one goes once it writes that (see update).
      this.refuse(previous.conn, 'replaced');
    }

    this.host.setSeat(conn, seat);
    // Cursors still left by those whose leaving never came through because the room server went
    // down are cleaned up here.
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
    // While someone is in, the room is checked on rather than deleted.
    this.host.occupied(this.nextCheckAt());
    if (previous) return true;
    this.broadcast(conn, { type: 'join', member: memberOf(seat) });
    this.host.lobbyChanged(seat.roomKey);
    this.host.record('join', seat.role, this.seats().length);
    return true;
  }

  /**
   * When the next check comes. Usually it is every OCCUPIED_CHECK_MS. When a logged-in seat's token
   * runs out sooner, it also looks at about TOKEN_GRACE_MS after the token runs out. This is so that
   * a seat whose token has run out is removed even in a room where nobody sends anything.
   */
  nextCheckAt(): number {
    const expiries = this.seats().flatMap(({ seat }) =>
      seat.expiresAt === undefined ? [] : [seat.expiresAt + TOKEN_GRACE_MS + 1000]
    );
    return Math.min(Date.now() + OCCUPIED_CHECK_MS, ...expiries);
  }

  /** Deletes the cursors of those not in the room. Returns the identifiers deleted. */
  private removeStrayCursors(): string[] {
    const here = new Set(this.seats().map(({ seat }) => seat.peerId));
    return this.store
      .owners()
      .filter((owner) => !here.has(owner))
      .flatMap((owner) => this.store.removeOwnedBy(owner));
  }

  /** Has those who hold the deleted cursors delete them. exclude (someone who has just come in) holds none. */
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

  /** The seat has left. Deletes what was kept only while it was there, and tells the others. */
  private leave(seat: Seat): void {
    this.handedBack.delete(seat.peerId);
    this.toldGone.delete(seat.peerId);
    if (this.store.removeOwnedBy(seat.peerId).length > 0) this.scheduleFlush();
    this.broadcast(undefined, { type: 'leave', peerId: seat.peerId });
    if (this.seats().length === 0) this.host.emptied();
    this.host.lobbyChanged(seat.roomKey);
    this.host.record('leave', seat.role, (Date.now() - seat.joinedAt) / 1000);
  }

  /** Sends the reason, then closes. A connection that was in the room is treated as having left. */
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

  /** Those in the room, leaving out exclude. */
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

  /** Whether the events sent are within the limit. Events packed into one frame count one by one. */
  private withinEvents(conn: C, count: number): boolean {
    const rate = this.rateOf(conn);
    rate.events += count;
    return rate.events <= MAX_EVENTS_PER_WINDOW;
  }

  /** Whether the dice asked for are within the number that may be asked for. */
  private withinRolls(conn: C): boolean {
    const rate = this.rateOf(conn);
    rate.rolls += 1;
    return rate.rolls <= MAX_ROLLS_PER_WINDOW;
  }

  // ---- Relay and sync ----

  /** The object's view as that seat sees it. */
  private kindOf(identifier: string, seat: Seat, lookup: Lookup = this.store.lookup): ViewKind {
    return viewKind(identifier, seat, lookup);
  }

  /** The form shown to that seat, or null when it is not shown. */
  private viewOf(identifier: string, seat: Seat): ObjectContext | null {
    const context = this.store.get(identifier);
    return context && viewFor(context, this.kindOf(identifier, seat));
  }

  /**
   * Delivers the events sent to their addressees, reading first those the server reads. Nothing goes
   * back to the sender.
   *
   * For each receiver they stay in the order they were sent. Those without an addressee go to
   * everyone else, and those with one go to that one alone. UPDATE and DELETE, once they change the
   * server's state, go out to those who may see them, in the form they may see, whatever the
   * addressee. What the server puts in (handing over and taking back what changed view, replies to
   * an old version, answers to catalogs) gets AUTHORITY_PEER_ID as sendFrom and goes in the same
   * bundle.
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
      // What only the server sends is not delivered when it comes from a client.
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
   * Sends each receiver's bundle. For receivers who get the same run of events, it is encoded only
   * once.
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
   * Applies an UPDATE to the state and sends it out to those who may see it, in the form they may
   * see.
   *
   * The sender may not write what it cannot see (WITHDRAW comes back). When someone holding the
   * masked form writes it back, the masked parts are put back to the stored contents. A
   * PeerCursor's role is overwritten with the role of that person's seat. A guest can write only its
   * own cursor and messages in tabs where guests may speak too.
   */
  private update(data: unknown, seat: Seat, sender: C, push: Push<C>): void {
    const parsed = safeParse(objectContextSchema, data);
    if (!parsed.success) return;
    let context = parsed.output;
    const { identifier, aliasName } = context;
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));

    // The kind of what is stored may not change, so that nothing else can be overwritten by passing
    // it off as a cursor.
    const existing = this.store.entryOf(identifier);
    if (existing && existing.alias !== aliasName) return this.refuseWrite(identifier, seat, reply);
    // A view hint that is too big fits neither in the index nor in one row of the store. New objects
    // are limited in number too. A version may not jump far at once.
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
        this.peeksIntoDeck(context, existing) ||
        movesTab(existing, context))
    )
      return this.refuseWrite(identifier, seat, reply);
    if (!existing && seat.role !== 'gm' && this.peeksIntoDeck(context, null))
      return this.refuseWrite(identifier, seat, reply);

    let owner: string | null = null;
    // Someone who holds the masked form keeps the masked form (the masked version) after the write is
    // taken, so that when it comes into view the difference in version gets it fetched again.
    let corrected = seen === 'masked';
    if (aliasName === PEER_CURSOR_ALIAS) {
      // Only the person a cursor belongs to can write it. Writing someone else's user id into one
      // would turn the whispers and dealt cards meant for that person toward the writer.
      const named = String(context.syncData.peerId);
      if (existing ? existing.owner !== seat.peerId : named !== seat.peerId) {
        if (existing || this.seats().some((other) => other.seat.peerId === named))
          return this.refuseWrite(identifier, seat, reply);
        // The cursor of someone who has left is not stored. Clients clean it up themselves on leave.
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
      // What has no view yet (its parent has not come) cannot have its contents sent back, so it is
      // taken back from the sender.
      if (!view) return this.refuseWrite(identifier, seat, reply);
      // The masked form carries a version lower than the real one, so it can be lower than the
      // sender's. An UPDATE would then be thrown away and the losing change would stay on that
      // person's screen alone, so it is made to replace whatever the version.
      reply(seen === 'masked' ? AuthorityEvent.AUTHORITATIVE : SyncEvent.UPDATE, view);
      if (seen === 'masked') this.noteHandedBack(seat.peerId, identifier);
    } else if (verdict === 'deleted') {
      reply(SyncEvent.DELETE, { aliasName, identifier });
    } else if (verdict === 'accept') {
      // A seat writing a cursor of another name, as a reloaded page does, leaves its old one behind.
      if (owner !== null && !existing) this.dropCursors(this.store.removeOwnedBy(seat.peerId), sender);
      const before = this.store.lookup(identifier);
      this.store.put(context, owner);
      const mine = this.kindOf(identifier, seat);
      if (mine === 'pending') this.pendingWriters.set(identifier, seat.peerId);
      else this.pendingWriters.delete(identifier);
      // What waits for its parent is handed back once the parent comes, as it is seen then.
      const again = delivered(mine) && this.madeAgain(seat.peerId, identifier);
      this.spread(context, before, seat, sender, push, corrected || again);
    }
  }

  /**
   * Whether a write leaves a card in a deck seen by someone who did not see it there before: by giving
   * a card in the deck an owner, or marking it as in someone's hand, or by moving into the deck a card
   * with either, or what holds such a card, or by making such a card there. A new object also counts
   * for the cards moved under it before it came. The owner and the one whose hand a card is in see
   * its face, which a deck keeps from everyone, so only the GM may. Axe takes the owner off a card it
   * puts in a deck and gives it the deck's place, and taking a card out of the deck, as into a hand,
   * is not this. Writes sent together are taken one by one, so drawing a card as its owner and
   * putting it back would otherwise go through.
   */
  private peeksIntoDeck(context: ObjectContext, existing: StoredEntry | null): boolean {
    const identifier = context.identifier;
    const next = describe(context);
    const written: DeckRow = { alias: context.aliasName, parent: next.parent, view: next.view };
    const after = (other: string) => (other === identifier ? written : this.store.lookup(other));
    const reached = existing?.parent === next.parent ? [] : this.store.descendantsOf(identifier);
    return [identifier, ...reached].some((other) => {
      const before = this.seersInDeck(other, this.store.lookup);
      return this.seersInDeck(other, after).some((seer) => !before.includes(seer));
    });
  }

  /**
   * Who sees the face of a card in a deck, as the rows `lookup` gives have it: its owner and the one
   * whose hand it is marked as in. None for a card in no deck and for anything but a card. Axe keeps
   * a deck's cards under a node of the deck's own, so every parent up is looked at, as far as
   * parents are followed anywhere.
   */
  private seersInDeck(identifier: string, lookup: (identifier: string) => DeckRow | null): string[] {
    const entry = lookup(identifier);
    if (entry?.view?.kind !== 'card') return [];
    let holder = lookup(entry.parent);
    for (let depth = 0; holder && depth < MAX_DEPTH; depth++) {
      if (holder.alias === CARD_STACK_ALIAS) return [entry.view.owner, entry.view.hand].filter((seer) => seer !== '');
      holder = lookup(holder.parent);
    }
    return [];
  }

  /**
   * Whether a write that changes the parent or the name (a data element's name decides where under a
   * card or note it sits) lets the writer itself see more of the object or its descendants than now.
   * The view follows the path of parents and names, so renaming, or moving out from under a parent
   * with rules, would hand over what is masked.
   */
  private uncovers(context: ObjectContext, existing: StoredEntry, seat: Seat): boolean {
    const next = describe(context);
    const renamed =
      existing.view?.kind === 'data' && next.view?.kind === 'data' && existing.view.name !== next.view.name;
    if (next.parent === existing.parent && !renamed) return false;
    const identifier = context.identifier;
    // Only the change of path is compared. State such as the card's facing and the hand is checked
    // by mayChangeView, so it is left as before here (drawing from the deck into one's own hand
    // changes the parent too, yet seeing the face is right).
    const moved = {
      parent: next.parent,
      view: next.view?.kind === 'data' ? next.view : existing.view,
    };
    const after: Lookup = (other) => (other === identifier ? { ...existing, ...moved } : this.store.lookup(other));
    // Under a parent not there yet, how it will look once the parent comes is unknown. It is compared
    // as the case that shows the most.
    const eventual = (kind: ViewKind): ViewKind => (kind === 'pending' ? 'full' : kind);
    return [identifier, ...this.store.dependentsOf(identifier)].some((other) =>
      looser(eventual(this.kindOf(other, seat, after)), eventual(this.kindOf(other, seat)))
    );
  }

  /**
   * Sends out what was stored. The others get it in the form they may see (WITHDRAW for those who
   * can no longer see it), and the sender gets the corrected one back when its view or contents
   * differ from what it sent. When the view changes, what that view decides the view of
   * (descendants, reactions) is also handed to those who can now see it and taken back from those
   * who no longer can.
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
    // What still waits for its parent (pending) stays as it is on the sender's side.
    const mine = this.kindOf(identifier, seat);
    if (mine === 'hidden') push(sender, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
    else if (corrected && delivered(mine)) {
      push(sender, fromAuthority(AuthorityEvent.AUTHORITATIVE, viewFor(context, mine)));
      this.noteHandedBack(seat.peerId, identifier);
    }

    // When the view hint or the parent changed, or it is the first time it has come (its children
    // may have been waiting for it), the descendants' views are compared again.
    const after = this.store.lookup(identifier) as StoredEntry;
    if (!before || before.parent !== after.parent || JSON.stringify(before.view) !== JSON.stringify(after.view)) {
      this.revisit(this.store.dependentsOf(identifier), this.seats(), was, push, sender);
    }
  }

  /**
   * What decides their view has changed, so compares the view of each one again, seat by seat.
   * Those who can now see it get it in AUTHORITATIVE_OBJECT (which replaces it even at the same
   * version), and those who no longer can are made to take it back with WITHDRAW.
   *
   * When something that waited for its parent (pending) comes into view, it is not handed to writer.
   * Only someone who has the parent (the one who sent the parent) can make a child that waits for
   * it, so writer has it already. But what a catalog had taken back while it waited for its parent
   * is handed to writer too, and so is what writer was told had gone and made again before the
   * word came, which the word took from it, and what somebody else wrote while it waited.
   */
  private revisit(
    identifiers: string[],
    seats: { conn: C; seat: Viewer }[],
    was: Lookup,
    push: Push<C>,
    writer?: C
  ): void {
    // Who wrote what waited is minded no longer once it has its parent: it may wait again later,
    // moved under a parent not there yet, and what is taken back then is handed back to all.
    const arrived = new Set<string>();
    for (const { conn, seat } of seats) {
      for (const identifier of identifiers) {
        const then = viewKind(identifier, seat, was);
        const now = viewKind(identifier, seat, this.store.lookup);
        if (then === 'pending' && now !== 'pending') arrived.add(identifier);
        const withdrawn = then === 'pending' && !!this.withdrawnPending.get(seat.userId)?.has(identifier);
        const writerPeerId = conn === writer ? (this.host.seatOf(conn) as Seat).peerId : '';
        const remade = then === 'pending' && delivered(now) && this.madeAgain(writerPeerId, identifier);
        const own = this.pendingWriters.get(identifier) === writerPeerId;
        if (conn === writer && then === 'pending' && own && !withdrawn && !remade) continue;
        this.resend(conn, identifier, then, now, push);
        // While a parent one step further up has still not come, it has not been handed over yet, so
        // it stays remembered.
        if (withdrawn && now !== 'pending') this.withdrawnPending.get(seat.userId)?.delete(identifier);
      }
    }
    for (const identifier of arrived) this.pendingWriters.delete(identifier);
  }

  /**
   * Hands what changed view from then to now to that seat, or takes it back. Does nothing when the
   * view did not change.
   */
  private resend(conn: C, identifier: string, then: ViewKind, now: ViewKind, push: Push<C>): void {
    if (then === now) return;
    if (!delivered(now)) {
      if (delivered(then)) push(conn, fromAuthority(AuthorityEvent.WITHDRAW, { identifier }));
      return;
    }
    const context = this.store.get(identifier) as ObjectContext;
    push(conn, fromAuthority(AuthorityEvent.AUTHORITATIVE, viewFor(context, now)));
    this.noteHandedBack((this.host.seatOf(conn) as Seat).peerId, identifier);
  }

  /**
   * What a guest may write: new messages in tabs where guests may speak too (guestCanSpeak), and
   * rewrites of its own messages. Some messages, such as roll results, have a from that is not the
   * writer, so a new message may have any from.
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
   * In a message with a result the server rolled, the result, the name and the sender may not be
   * rewritten. But the one who rolled and the GM may disclose a secret (only by taking the word
   * secret out of tag, as Axe's discloseMessage does). A message the server did not roll may not
   * carry the mark of one it rolled. When something is corrected, it returns the corrected contents
   * (and what it took in, as it was, otherwise).
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
    // A disclosed line moves to the end (Axe's discloseMessage). Its time may not be pushed far into
    // the past, and of its place in the order only the fraction is taken.
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
    // Fields the original message did not have are dropped rather than set to undefined (which
    // arrives as null through MessagePack).
    const restored = Object.fromEntries(Object.entries(attributes).filter(([field]) => !guarded.includes(field)));
    for (const field of guarded) if (kept[field] !== undefined) restored[field] = kept[field];
    const syncData = Object.fromEntries(
      Object.entries(context.syncData).filter(
        ([field]) => field !== 'parentIdentifier' && !ROLLED_PLACE.includes(field)
      )
    );
    // A roll result always has its place in the order stored.
    for (const field of ROLLED_PLACE) syncData[field] = place[field];
    // A roll result is kept only in a tab right under the tab list.
    syncData.parentIdentifier = stored.syncData.parentIdentifier;
    return {
      ...context,
      syncData: { ...syncData, value: stored.syncData.value, attributes: restored },
    };
  }

  /**
   * Rolls the dice, makes the result message and sends it out. Rolls go in the order they were asked
   * for, and wait for loading only when a system is used for the first time. Does nothing when it is
   * not a command. A guest can roll only in a tab where it may speak.
   * The result goes out to those who may see it, in the form they may see (to a whisper's
   * addressees, and in the masked form for a secret).
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
    // When the same one is asked for again (after reconnecting and so on), it has been rolled
    // already, so nothing is sent back.
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
    // Rolling is heavy, so how many may be asked for is limited. Those past the limit are not rolled.
    if (!this.withinRolls(sender)) return reject(message.identifier, 'rate-limited');
    if (this.pendingRolls >= MAX_PENDING_ROLLS) return reject(message.identifier, 'busy');

    this.pendingRolls += 1;
    this.rollQueue = this.rollQueue
      .then(async () => {
        // Each roll gives other messages their turn first.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = Date.now();
        const rolled = await rollLine(request.gameSystem, request.command);
        // When the room was deleted during the roll, there is nowhere to put the result.
        if (!this.host.room()) return;
        this.host.record('roll', request.gameSystem, Date.now() - started);
        // When something with the same identifier was stored during the roll, nothing is made.
        const taken = this.store.entryOf(message.identifier) || this.store.isDeleted(message.identifier);
        if (taken) return;
        if (!rolled) return reject(message.identifier, 'not-a-command');
        // When the tab was deleted or moved during the roll, there is nowhere to put the result.
        if (!this.isListedTab(String(message.syncData.parentIdentifier))) return reject(message.identifier, 'invalid');
        // The text goes in syncData.value, and the rest in attributes, since they are SyncVars of
        // ChatMessage. Of the place in the order only the fraction within the tab asked for is taken,
        // and the trimmings and marks the one who asked added are removed.
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
            // The time of the one who asked may not be pushed far into the past to bury the line deep
            // in the order.
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
   * Has the sender undo, on its side, a change it has no right to write. When the server holds the
   * object, it is put back to the form shown to that seat; when it was deleted, the sender deletes
   * it; when neither (something the sender tried to make), the sender withdraws it without leaving a
   * tombstone.
   */
  private refuseWrite(identifier: string, seat: Seat, reply: Reply): void {
    const view = this.viewOf(identifier, seat);
    if (view) {
      reply(AuthorityEvent.AUTHORITATIVE, view);
      this.noteHandedBack(seat.peerId, identifier);
    } else if (this.store.isDeleted(identifier)) reply(SyncEvent.DELETE, { aliasName: '', identifier });
    else reply(AuthorityEvent.WITHDRAW, { identifier });
  }

  /**
   * Applies a DELETE to the state. A guest can delete only its own cursor. Nothing may be deleted by
   * someone who cannot see it.
   *
   * The descendants of what is deleted are deleted with it. Descendants the sender could not see
   * (such as the face of a face-down card) are not on the sender's side, so no delete for them comes
   * from the sender. The server sends a DELETE to those who hold them. What of it was handed back to
   * the sender lately is told back as gone, the sender having perhaps taken it back after deleting.
   */
  private remove(event: EventContext, seat: Seat, sender: C, push: Push<C>): void {
    const parsed = safeParse(deleteSchema, event.data);
    if (!parsed.success) return;
    const { aliasName, identifier } = parsed.output;
    const reply: Reply = (eventName, data) => push(sender, fromAuthority(eventName, data));
    const entry = this.store.entryOf(identifier);
    // Already deleted as a descendant.
    if (!entry && this.store.isDeleted(identifier)) return;
    if (this.kindOf(identifier, seat) === 'hidden') return;
    const owner = entry?.owner ?? null;
    // What is kept only while its person is there (a cursor) can be deleted only by that person.
    if ((owner !== null || seat.role === 'guest') && owner !== seat.peerId)
      return this.refuseWrite(identifier, seat, reply);
    const kept = this.keptFromDeleting.get(seat.peerId);
    // What cannot be seen has dropped out above, and what is left are descendants with all their
    // parents there, so they have reached the sender. Each delete of them keeps the rest for longer:
    // Axe paces what it sends, and the lines of a long tab come over more than one window.
    if (kept && kept.until > Date.now() && kept.ids.has(identifier)) {
      kept.until = Date.now() + KEEP_FROM_DELETING_MS;
      this.keepAwake();
      return this.refuseWrite(identifier, seat, reply);
    }
    const doomed = [identifier, ...this.store.descendantsOf(identifier)];
    // Nobody but the GM may delete a result the server rolled, and the same goes for deleting the
    // whole tab. It is gone from the sender's side already, so everything it can see is sent back.
    // The lines inside, whose deletes come next, are also kept from being deleted for a while.
    if (seat.role !== 'gm' && doomed.some((id) => this.isServerRoll(id))) {
      for (const id of doomed) {
        if (delivered(this.kindOf(id, seat))) this.refuseWrite(id, seat, reply);
      }
      const ids = kept && kept.until > Date.now() ? kept.ids : new Set<string>();
      for (const id of doomed) ids.add(id);
      this.keptFromDeleting.set(seat.peerId, { ids, until: Date.now() + KEEP_FROM_DELETING_MS });
      this.keepAwake();
      return;
    }
    const others = this.seats(sender);
    const seen = new Map(others.map(({ conn, seat: other }) => [conn, doomed.map((id) => this.kindOf(id, other))]));
    // Whether to leave a tombstone is decided by the kind stored. Trusting the kind sent, anything
    // could be deleted without a tombstone by passing it off as a cursor, and it would come back from
    // someone holding an old copy.
    const cursor = entry ? entry.alias === PEER_CURSOR_ALIAS : aliasName === PEER_CURSOR_ALIAS;
    for (const id of doomed) {
      this.store.delete(id, !cursor);
      this.pendingWriters.delete(id);
    }
    const handed = this.handedBackTo(seat.peerId);
    doomed.forEach((id, index) => {
      if (!handed?.ids.delete(id)) return;
      const told = this.toldGone.get(seat.peerId);
      if (told) told.add(id);
      else this.toldGone.set(seat.peerId, new Set([id]));
      push(sender, fromAuthority(SyncEvent.DELETE, { aliasName: index === 0 ? aliasName : '', identifier: id }));
    });
    for (const { seat: other } of others) {
      const theirs = this.handedBack.get(other.peerId);
      for (const id of doomed) theirs?.ids.delete(id);
    }
    for (const { conn } of others) {
      doomed.forEach((id, index) => {
        if (!delivered((seen.get(conn) as ViewKind[])[index])) return;
        push(conn, id === identifier ? event : fromAuthority(SyncEvent.DELETE, { aliasName: '', identifier: id }));
      });
    }
  }

  /** Whether it is a tab for everyone, right under the chat tab list. Roll results are kept there alone. */
  private isListedTab(identifier: string): boolean {
    const tab = this.store.entryOf(identifier);
    return tab?.alias === CHAT_TAB_ALIAS && tab.parent === CHAT_TAB_LIST_IDENTIFIER;
  }

  private isServerRoll(identifier: string): boolean {
    const stored = this.store.entryOf(identifier)?.alias === CHAT_MESSAGE_ALIAS && this.store.get(identifier);
    return stored ? attributesOf(stored)[SERVER_ROLL_FIELD] === true : false;
  }

  /** It is not taken from a guest. */
  private forget(data: unknown, seat: Seat): boolean {
    const parsed = safeParse(forgetSchema, data);
    if (!parsed.success || seat.role === 'guest') return false;
    this.store.forget(parsed.output.identifiers ?? []);
    return true;
  }

  /**
   * Changes the role of someone in the room when a GM asks. It updates the table of seats, rewrites
   * the role on that person's cursor, raises its version and sends it out to everyone. What changes
   * view with the role (the faces of face-down cards, secrets, a tab's messages and so on) is handed
   * to that person or taken back. When it refuses, it sends the reason back to the one who asked.
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
      // Every object is compared between the old role and the new one.
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
    // Whether assets may be put depends on the role, so the token is swapped for one with the new
    // role.
    for (const { conn, seat: other } of this.seats()) {
      if (other.userId !== target.userId) continue;
      this.post(conn, { type: 'asset-token', ...this.assetTokenFor(other, 'expiresAt'), role });
    }
  }

  /**
   * Answers a client's catalog. What the server lacks or holds an older version of, it asks to be
   * sent; what was deleted, the client is made to delete; and what the seat cannot see, the client is
   * made to take back.
   * What is newer on the server, the client comes to get after seeing the server's catalog.
   */
  private answerCatalog(data: unknown, seat: Seat, reply: Reply): void {
    const parsed = safeParse(catalogSchema, data);
    if (!parsed.success) return;
    for (const { identifier, version } of parsed.output) {
      if (this.store.isDeleted(identifier)) {
        reply(SyncEvent.DELETE, { aliasName: '', identifier });
        continue;
      }
      // What has no view yet (its parent has not come) is taken back too until it has one. Once it has
      // one and can be seen, it is handed over.
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

  /** Sends back what was asked for, in the form shown to that seat. Nothing goes back for what is not shown. */
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
   * The catalog shown to that seat, leaving out what is not shown. At least one is sent even when it
   * is empty, so that the client can tell the catalog has all been sent.
   */
  private catalogEvents(seat: Seat): EventContext[] {
    const catalog = this.store.catalog().flatMap((item) => {
      const kind = this.kindOf(item.identifier, seat);
      if (!delivered(kind)) return [];
      if (kind === 'full') return [item];
      // It carries the version lower than the real one, the same as when the masked form is handed
      // over.
      const entry = this.store.entryOf(item.identifier) as StoredEntry;
      return [{ ...item, version: entry.majorVersion + maskedMinor(entry.minorVersion) }];
    });
    const events = [fromAuthority(SyncEvent.CATALOG, catalog.slice(0, CATALOG_BATCH))];
    for (let start = CATALOG_BATCH; start < catalog.length; start += CATALOG_BATCH) {
      events.push(fromAuthority(SyncEvent.CATALOG, catalog.slice(start, start + CATALOG_BATCH)));
    }
    return events;
  }

  // ---- Sending ----

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

  // ---- Store ----

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => this.flushNow(), FLUSH_DELAY_MS);
  }

  /**
   * Writes the gathered changes without waiting. It is also called before the room server lets go
   * of the room (in the Vercel version, when the last one leaves). How many were written is logged
   * all together, at intervals.
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
