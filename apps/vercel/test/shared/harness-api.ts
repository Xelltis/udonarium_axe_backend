import type { AssetUploadPolicy } from '../../contracts/protocol.js';
import type { RoomInit } from '../../src/core/http/backend.js';
import type { RoomEngine } from '../../src/core/rooms/engine.js';
import type { RoomHost } from '../../src/core/rooms/host.js';

// Where the shared tests touch the room server. Each room server's test/harness.ts exports a harness
// that implements this. The shared tests touch the room server's insides only through it.

/** A connected WebSocket, in the shape the tests use. */
export interface TestSocket {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  /** The frames that arrive. Binary ones are passed as an ArrayBuffer. */
  onMessage(listener: (data: ArrayBuffer | string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}

/** The result of a request to upgrade to a WebSocket. */
export interface Upgraded {
  status: number;
  /** Only when connected. Null when refused, and then the body is read with json. */
  socket: TestSocket | null;
  json(): Promise<unknown>;
}

/** A room asset in the store. */
export interface StoredAsset {
  /** The type decided from the first bytes when it was stored. */
  type: string | undefined;
  size: number;
  /** The ETag, in quotes. The same as the ETag of a GET. */
  etag: string;
  /** When it was stored (Unix milliseconds). */
  uploadedAt: number;
}

/** The inside of a room. What the room server gives RoomEngine. */
export interface RoomInside {
  engine: RoomEngine<object>;
  host: RoomHost<object>;
}

export interface Harness {
  /**
   * How assets are stored, as told in welcome. Null for a room server where one PUT can store up to
   * the limit for each type.
   */
  assetUpload: AssetUploadPolicy | null;
  /** A request to the room server. The sender's IP goes in CF-Connecting-IP. */
  fetch(request: Request): Promise<Response>;
  /**
   * A request to the room server with other environment variables. A variable that is undefined is
   * left unset. Returns after waiting for everything to end (the work left for later too).
   */
  fetchWith(request: Request, env: Record<string, string | undefined>): Promise<Response>;
  upgrade(request: Request): Promise<Upgraded>;
  /** Calls run inside the room. Used to set up or check the room's state. */
  inside<T>(roomKey: string, run: (room: RoomInside) => T | Promise<T>): Promise<T>;
  /** Makes a room with a chosen key. For the asset tests, which use rooms with fixed keys. */
  createRoom(init: RoomInit): Promise<void>;
  canUpload(roomKey: string, userId: string): Promise<'ok' | 'room-not-found' | 'not-a-player'>;
  /** Takes only the login settings away from the room server (the room stays). */
  dropLogin(roomKey: string): Promise<void>;
  /** An asset kept in the room. Null when there is none. */
  assetStored(roomKey: string, id: string): Promise<StoredAsset | null>;
  /** The operator stops anything with that name from being stored. */
  block(id: string): Promise<void>;
  /** Makes an account's code for coming back from a login (the row's id) expire. */
  expireLoginCode(accountKey: string, id: string): Promise<void>;
  /** Makes all of an account's refresh tokens expire. */
  expireRefreshTokens(accountKey: string): Promise<void>;
}
