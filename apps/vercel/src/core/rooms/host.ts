import type { AssetUploadPolicy, PeerRole } from '../../../contracts/protocol.js';
import type { ObjectIndex } from './object-index.js';
import type { PasswordHash } from './password.js';

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
  /** Came in logged in. Someone not logged in stays a guest, whose role cannot be changed. */
  account: boolean;
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
  /** Changes a role. */
  set(userId: string, role: PeerRole): void;
  /** How many GMs there are (counting those not in a seat now). */
  gameMasterCount(): number;
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
  /** Nobody is left. The retention period counts from here. */
  emptied(): void;
  /** Updates the head count and the GMs in the room list. */
  lobbyChanged(roomKey: string): void;
  record(event: RoomEvent, detail: string, value: number): void;
  /** Work that goes on until it is done, even after returning. */
  defer(work: Promise<unknown>): void;
}
