import type { AssetUploadPolicy, PeerRole } from '../../../contracts/protocol.js';
import type { BanList } from '../moderation/bans.js';
import type { ObjectIndex } from './object-index.js';
import type { PasswordHash } from './password.js';

/** The roles that may store an asset in a room. */
export const UPLOADER_ROLES: readonly PeerRole[] = ['gm', 'pl'];

/** Whether the seat is that account's, seated with one of the roles. */
export const seatedAs = (seat: Seat, userId: string, roles: readonly PeerRole[]): boolean =>
  seat.account && seat.userId === userId && roles.includes(seat.role);

/**
 * What is kept for each connection, none until its hello is let in. The room server decides where it
 * is kept (the Cloudflare version keeps it with the WebSocket, so it outlasts waking from hibernation).
 */
export interface Seat {
  peerId: string;
  userId: string;
  /** The key used to tell the room list how many people are in the room. */
  roomKey: string;
  /** The role the server decided. */
  role: PeerRole;
  /**
   * The role the room keeps for someone logged in, which `role` differs from while they watch as a
   * guest. Missing for someone not logged in.
   */
  keptRole?: PeerRole;
  /** Came in logged in. Someone not logged in stays a guest, whose role cannot be changed. */
  account: boolean;
  /** The account (`discord:<ID>`) of someone who came in logged in. The operator's bans go by it. */
  accountKey?: string;
  /** The sender's IP address, as the room server was told it when the connection was made. */
  address?: string;
  /** When the seat came in (Unix milliseconds). */
  joinedAt: number;
  /** When the access token of someone who came in logged in runs out (Unix milliseconds). A new token extends it. */
  expiresAt?: number;
  /**
   * When the person last used the page, as the seat told it (Unix milliseconds). active brings it up
   * to now. A seat left at it for IDLE_MS is closed.
   */
  activeAt: number;
  /** The server closed it (refused it, or it was replaced by a new connection with the same peer id). */
  closed?: boolean;
}

/** What is needed about the room to make a seat. */
export interface RoomFacts {
  roomKey: string;
  /** Null for a room without a password. */
  password: PasswordHash | null;
}

/** The events written to the room's log. */
export type RoomEvent = 'join' | 'leave' | 'refuse' | 'flush' | 'roll' | 'delete';

/**
 * The role of each person who has come in logged in. It is read and written synchronously, so that no
 * other message cuts in between checking and writing.
 */
export interface RoleBook {
  /** The role remembered, or null for someone who has never come in. */
  roleOf(userId: string): PeerRole | null;
  /** Remembers the role of someone taking a seat for the first time. */
  add(userId: string, role: PeerRole): void;
  /** Changes a role, and ends any watching, as the change is the GM's say on it. */
  set(userId: string, role: PeerRole): void;
  /** How many GMs there are (counting those not in a seat now). */
  gameMasterCount(): number;
  /**
   * Whether someone has stepped out to watch as a guest. Their role stays as it was, for them to come
   * back to, and counts as ever among the GMs.
   */
  isWatching(userId: string): boolean;
  /** Starts or stops someone watching. */
  setWatching(userId: string, watching: boolean): void;
}

/** The store for the room's objects. flush returns how many it wrote (used for the log). */
export interface RoomStore extends ObjectIndex {
  flush(): number;
}

/**
 * What the room server hands RoomEngine: connections, seats, the room's row, roles, the store, the
 * clock, the room list and the log.
 * C stands for a connection (a WebSocket in the Cloudflare version).
 */
export interface RoomHost<C extends object> {
  /** Every connection taken in, including those before their hello and those closing. */
  connections(): readonly C[];
  seatOf(conn: C): Seat | null;
  setSeat(conn: C, seat: Seat): void;
  /**
   * The sender's IP address, as the room server was told it when the connection was made, which goes
   * on the seat so that the operator's bans can find it. Kept with the connection, where it outlasts
   * the room sleeping before the hello comes.
   */
  addressOf(conn: C): string | undefined;
  /** Sends a frame. Does nothing when the connection is closing and cannot send. */
  send(conn: C, frame: Uint8Array): void;
  /** Closes the connection. Does nothing when it is already closed. */
  close(conn: C, code: number, reason: string): void;
  /** The room, or null when it has not been made or is being deleted. */
  room(): RoomFacts | null;
  /** Whether the room is being deleted right now. */
  wiping(): boolean;
  store(): RoomStore;
  readonly roles: RoleBook;
  /** The key that checks and makes tokens, or null when login is not set up. */
  sessionSecret(): string | null;
  /** How assets are put, told in welcome. Null when a single PUT can put each kind up to its limit. */
  assetUploadPolicy(): AssetUploadPolicy | null;
  /** Someone came in. A check comes by nextCheckAt. */
  occupied(nextCheckAt: number): void;
  /**
   * The next check moved, as when a seat's token was renewed. Without it, the check set for the old
   * expiry comes anyway and finds nothing to do.
   */
  recheckAt(at: number): void;
  /** Nobody is left. The retention period counts from here. */
  emptied(): void;
  /** Updates the head count and the GMs in the room list. */
  lobbyChanged(roomKey: string): void;
  /** Settles once the room list has been told of every change so far (lobbyChanged). Never fails. */
  listed(): Promise<void>;
  /**
   * The operator's bans as they stand, which a hello is checked against. A room server that asks its
   * store for them gives a promise, which never fails: when they cannot be read, it gives those read
   * last.
   */
  bans(): BanList | Promise<BanList>;
  record(event: RoomEvent, detail: string, value: number): void;
  /** Work that goes on until it is done, even after returning. */
  defer(work: Promise<unknown>): void;
}
