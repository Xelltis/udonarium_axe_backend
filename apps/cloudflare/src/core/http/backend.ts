import type { Account, DirectUploadTarget, RoomAsset, RoomSummary } from '../../../contracts/protocol.js';
import type { Profile, Secret, Session } from '../auth/secrets.js';
import type { LoginConfig } from '../config/login.js';

/** The settings the room server's routes need. Each room server keeps its own settings on top of these. */
export interface ServerConfig {
  /** The Origins accepted for rooms, assets and login. */
  allowedOrigins: string[];
  login: LoginConfig | null;
}

/** What is handed over to make a room. */
export interface RoomInit {
  roomKey: string;
  roomId: string;
  name: string;
  /** Empty for a room without a password. */
  password: string;
  /** The user id of the one who made the room. That person becomes GM. */
  creatorUserId: string;
  /** The host name the request came to. It keeps the log apart from other instances on the same store. */
  host: string;
}

/** What each sender may do only so many times. The room server decides the limits. */
export type LimitKind = 'upload' | 'read' | 'room' | 'auth';

/** The account of one person who has logged in. */
export interface AccountPort {
  signIn(profile: Profile, challenge: string): Promise<Secret>;
  redeem(code: Secret, verifier: string): Promise<Session | null>;
  refresh(token: Secret): Promise<Session | null>;
  signOut(token: Secret): Promise<void>;
  account(): Promise<Account | null>;
  erase(userId: string): Promise<boolean>;
}

/** The store for room assets. */
export interface AssetBackend {
  /** Whether whoever runs the server has barred it from being stored. */
  blocked(id: string): Promise<boolean>;
  /** Whether it is already stored in that room. */
  exists(roomKey: string, id: string): Promise<boolean>;
  /**
   * Stores it. body is the contents flowing in from the start, and should be length bytes. When the
   * hash of the contents does not match id, it is not stored and the answer is 'hash-mismatch'.
   */
  store(
    roomKey: string,
    id: string,
    body: ReadableStream<Uint8Array>,
    length: number,
    type: string,
    name: string
  ): Promise<'stored' | 'hash-mismatch'>;
  /** Removes what was stored (when the room was deleted while it was being stored). */
  discard(roomKey: string, id: string): Promise<void>;
  /**
   * The response to a GET. The token has been checked. Rate limits, conditional requests and Range
   * are handled here.
   */
  read(request: Request, roomKey: string, id: string): Promise<Response>;
  /** The response to a HEAD. The token has been checked. */
  head(request: Request, roomKey: string, id: string): Promise<Response>;
  /** What is stored in that room. */
  list(roomKey: string): Promise<RoomAsset[]>;
  /** Extra work done after something new is stored (such as cleaning up what failed to be deleted). */
  afterStore(): void;
  /**
   * The steps for uploading straight to the store. Only a room server with a limit on the body of
   * one request (the Vercel version) has them.
   */
  direct?: DirectUploads;
}

/**
 * The steps for uploading straight to the store. An upload goes first to where uploads wait, and
 * becomes a room asset once checked.
 */
export interface DirectUploads {
  /** The limit on the bytes taken in one PUT. Anything over it is uploaded straight to the store. */
  maxPutBytes: number;
  /** Makes a target that lets up to size bytes be uploaded, once only, to where the upload waits. */
  target(path: string, size: number): Promise<DirectUploadTarget>;
  /** Streams the contents of the waiting upload. Null when there are none (not uploaded yet, or cleaned up). */
  open(path: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Deletes the waiting upload. */
  discard(path: string): Promise<void>;
}

/**
 * What the room server hands to the shared routes. It is made for each request and takes only the
 * Request.
 */
export interface ServerBackend {
  /** Whether it is within the limit counted for each sender. */
  limit(request: Request, kind: LimitKind): Promise<boolean>;
  lobby: {
    /** The room list. Given userId, it adds deletable to the rooms where that person is GM. */
    list(userId?: string): Promise<RoomSummary[]>;
    find(roomKey: string, userId?: string): Promise<RoomSummary | null>;
  };
  rooms: {
    create(init: RoomInit): Promise<void>;
    remove(roomKey: string, userId: string): Promise<'deleted' | 'not-found' | 'not-game-master'>;
    canUpload(roomKey: string, userId: string): Promise<'ok' | 'room-not-found' | 'not-a-player'>;
    /** Connects to the room's WebSocket. The Origin and the rate limit have been checked. */
    connect(request: Request, roomKey: string): Promise<Response>;
  };
  account(accountKey: string): AccountPort;
  assets: AssetBackend;
}

/** The Hono type of the shared routes. The room server sets config and backend first. */
export interface ServerEnv {
  Variables: { config: ServerConfig; backend: ServerBackend };
}
