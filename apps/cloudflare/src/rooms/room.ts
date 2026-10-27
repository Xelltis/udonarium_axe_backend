import { DurableObject } from 'cloudflare:workers';

import { PING, PONG } from '../../contracts/protocol';
import type { PeerRole } from '../../contracts/protocol';
import { deleteRoomAssets } from '../assets/sweep';
import { parseConfig } from '../config';
import { hashPassword } from '../core/rooms/password';
import { RoomEngine } from '../core/rooms/engine';
import type { RoomInit } from '../core/http/backend';
import { banCache, seatBarredBy } from '../core/moderation/bans';
import type { Ban, BanList } from '../core/moderation/bans';
import type { RoleBook, RoomEvent, RoomFacts, RoomHost, Seat } from '../core/rooms/host';
import { MODERATION_NAME } from '../moderation/store';
import { LOBBY_NAME } from './lobby';
import { RoomStore, migrate } from './store';

/** How long to wait before deleting a room again when it could not be deleted all the way (milliseconds). */
export const WIPE_RETRY_MS = 60_000;

interface RoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  host: string;
  room_id: string;
  name: string;
  password_salt: ArrayBuffer | null;
  password_hash: ArrayBuffer | null;
  /** When the last person left. Null while someone is there. */
  emptied_at: number | null;
}

/**
 * One room. It takes the WebSockets of the people in the room, leaves relaying and syncing to
 * RoomEngine, and holds the room's state.
 * When the retention period has passed since the last person left, it deletes the whole room.
 *
 * Memory is lost on going into hibernation, so what is kept for each connection (the seat) goes with
 * the WebSocket, and the state is kept in SQLite. Memory holds only what can be read again (the index)
 * and what does no harm when lost (the counts of sending too much).
 */
export class RoomDurableObject extends DurableObject<Env> implements RoomHost<WebSocket> {
  private storeCache: RoomStore | null = null;
  private lobbyQueue: Promise<void> = Promise.resolve();
  /**
   * The room is being deleted. Deleting waits on the room list and R2, so this mark keeps out what
   * comes in meanwhile. Once the room is deleted its row is gone too, so keeping this in memory is
   * enough.
   */
  private deleting = false;
  private readonly engine = new RoomEngine<WebSocket>(this);
  /** The operator's bans, read afresh for each hello. */
  private readonly banned = banCache(() => this.env.MODERATION.getByName(MODERATION_NAME).state());

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Makes the room. Called from the Worker's POST /v1/rooms. */
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
    // The role of each person who logged in. Whoever made the room becomes a GM.
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
      Date.now()
    );
    // When nobody comes in, the room goes after the retention period, as when everyone in it has left.
    await this.ctx.storage.setAlarm(Date.now() + this.retentionMs());
    await this.lobby().register(
      {
        roomKey: init.roomKey,
        roomId: init.roomId,
        name: init.name,
        hasPassword: password !== null,
        members: 0,
      },
      init.creator
    );
    await this.lobby().setGameMasters(init.roomKey, [init.creatorUserId]);
  }

  /**
   * Deletes the room. Called from the Worker's DELETE /v1/rooms/:roomKey. Only a GM of the room can
   * delete it, or the operator (userId null) from the dashboard. The people in it are sent
   * room-deleted and then closed, and as when the retention period has passed, the room is taken off
   * the list and everything kept is deleted.
   */
  async deleteRoom(userId: string | null): Promise<'deleted' | 'not-found' | 'not-game-master'> {
    const room = this.roomRow();
    if (!room || this.deleting) return 'not-found';
    if (userId !== null && this.roles.roleOf(userId) !== 'gm') return 'not-game-master';

    this.record('delete', userId === null ? 'operator' : 'gm', this.engine.seats().length);
    this.engine.closeAll();
    await this.wipe(room.room_key);
    return 'deleted';
  }

  /**
   * Whether the person about to store an asset still has a role in this room that can store one (GM
   * or player). Asked from the asset PUT. A token works for 15 minutes, so it refuses when the room has
   * gone in that time, or the person has been made a guest.
   */
  canUpload(userId: string): 'ok' | 'room-not-found' | 'not-a-player' {
    return this.engine.canUpload(userId);
  }

  /**
   * Whether someone taking an asset out of this room is its GM now, or a player who added it. Asked
   * from the asset DELETE.
   */
  canDiscard(userId: string, assetId: string): 'ok' | 'room-not-found' | 'not-game-master' {
    return this.engine.canDiscard(userId, assetId);
  }

  // ---- What the room's assets take up ----
  // Kept as they are stored and taken out, so that the room's limit (ROOM_STORAGE_LIMIT_MB) is
  // checked without listing them in R2. Each asset's size is kept by its id, so that one stored or
  // taken out twice (as by requests at the same moment) counts once. It is counted by listing once,
  // the first time it is asked for, and goes with the rest of the room.

  /** The bytes the room's assets take up, or null while not counted yet (or when the room is gone). */
  assetBytes(): number | null {
    if (!this.roomRow() || !this.assetBytesCounted()) return null;
    return this.ctx.storage.sql.exec<{ bytes: number }>('SELECT bytes FROM asset_bytes').one().bytes;
  }

  /** Counts an asset stored, once the room has been counted, unless it is counted already. */
  keepAsset(id: string, size: number): void {
    if (!this.roomRow() || !this.assetBytesCounted()) return;
    const sql = this.ctx.storage.sql;
    if (sql.exec('INSERT OR IGNORE INTO asset_sizes (id, size) VALUES (?, ?)', id, size).rowsWritten > 0) {
      sql.exec('UPDATE asset_bytes SET bytes = bytes + ?', size);
    }
  }

  /** Takes an asset taken out off the count, when it is counted. */
  dropAsset(id: string): void {
    if (!this.roomRow() || !this.assetBytesCounted()) return;
    const sql = this.ctx.storage.sql;
    const [gone] = sql.exec<{ size: number }>('DELETE FROM asset_sizes WHERE id = ? RETURNING size', id).toArray();
    if (gone) sql.exec('UPDATE asset_bytes SET bytes = bytes - ?', gone.size);
  }

  /**
   * Keeps what listing found, unless the room has been counted meanwhile. Returns what the room
   * stands at. Nothing is kept for a room that is gone.
   */
  countAssetBytes(assets: { id: string; size: number }[]): number {
    const listed = assets.reduce((sum, asset) => sum + asset.size, 0);
    if (!this.roomRow()) return listed;
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS asset_bytes (id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS asset_sizes (id TEXT PRIMARY KEY, size INTEGER NOT NULL)');
    if (sql.exec('INSERT OR IGNORE INTO asset_bytes (id, bytes) VALUES (1, ?)', listed).rowsWritten > 0) {
      for (const { id, size } of assets)
        sql.exec('INSERT OR IGNORE INTO asset_sizes (id, size) VALUES (?, ?)', id, size);
    }
    return sql.exec<{ bytes: number }>('SELECT bytes FROM asset_bytes').one().bytes;
  }

  private assetBytesCounted(): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_bytes'").toArray()
        .length > 0
    );
  }

  /** Who is in the room now, for the operator's dashboard. */
  seats(): Seat[] {
    return this.engine.seats().map(({ seat }) => seat);
  }

  /** Closes the connections the operator's ban covers. Returns how many it closed. */
  expel(ban: Ban): number {
    return this.engine.expel(seatBarredBy(ban));
  }

  /**
   * Takes a WebSocket connection, which the Worker passes on after checking the Origin, the bans and
   * the rate limit. Even when there is no room or it is full, it connects, sends the reason, and then
   * closes. Its hello is checked against the bans as they stand (bans).
   */
  override async fetch(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    // The sender's address goes in the socket's tags, which outlast the room sleeping before the hello.
    const address = request.headers.get('CF-Connecting-IP');
    this.ctx.acceptWebSocket(server, address === null ? [] : [address]);
    this.engine.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.engine.receive(ws, message);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.engine.closed(ws);
    // The other side closed, so this closes back to finish the closing steps. A code that cannot be sent
    // (such as 1005) is answered with 1000.
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
    } catch {
      // Already closed.
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.engine.closed(ws);
  }

  /**
   * The room's alarm. With people in the room, it checks, brings the count in the list up to date, and
   * checks again later. When everyone is gone without their leaving being seen (as when the Worker went
   * down), it starts counting the retention period from then. When the retention period has passed since
   * the last person left, it takes the room off the list and deletes everything kept.
   */
  override async alarm(): Promise<void> {
    // Deletes again a room that could not be deleted all the way. If it is being deleted right now, the
    // alarm waits for that to end and comes back.
    const deleting = this.deletingRoomKey();
    if (deleting !== null && this.deleting) {
      await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
      return;
    }
    if (deleting !== null) return this.wipe(deleting);
    // Removes the seats whose token has run out. When the last one was removed, the alarm for the
    // retention period has been set, as when someone leaves.
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
   * Takes the room off the list and deletes all of its assets, everything kept, and the alarm. When an
   * asset is missed, the room is no longer in the list, so the sweep that comes with uploads picks it up.
   */
  private async wipe(roomKey: string | null): Promise<void> {
    this.deleting = true;
    try {
      if (roomKey) {
        // Writes first that the deletion has begun, so that even if it fails partway or the Worker goes
        // down, the room does not go back to one that can be joined. The alarm that comes to delete the
        // rest after a crash is also set before asking anything outside (the old alarm may be the end of
        // the retention period).
        const sql = this.ctx.storage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS deleting (room_key TEXT NOT NULL)');
        sql.exec('DELETE FROM deleting');
        sql.exec('INSERT INTO deleting (room_key) VALUES (?)', roomKey);
        await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
        await this.lobby().remove(roomKey);
        await deleteRoomAssets(this.env.ASSETS, roomKey).catch((err: unknown) =>
          console.error('Room asset deletion failed:', err)
        );
      }
      this.engine.stopFlushing();
      this.storeCache = null;
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    } catch (err) {
      // It could not be deleted all the way, as when it could not be taken off the list. The alarm comes
      // back to delete it again.
      console.error('Room deletion failed, to be tried again:', err);
      await this.ctx.storage.setAlarm(Date.now() + WIPE_RETRY_MS);
    } finally {
      this.deleting = false;
    }
  }

  /** The key of a room whose deletion began and has not finished. Null when there is none. */
  private deletingRoomKey(): string | null {
    const sql = this.ctx.storage.sql;
    const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deleting'").toArray();
    if (exists.length === 0) return null;
    // Just one row is written when the deletion begins, and the whole table goes when it ends.
    return sql.exec<{ room_key: string }>('SELECT room_key FROM deleting').one().room_key;
  }

  // ---- What RoomEngine is given ----

  connections(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  seatOf(ws: WebSocket): Seat | null {
    return ws.deserializeAttachment() as Seat | null;
  }

  setSeat(ws: WebSocket, seat: Seat): void {
    ws.serializeAttachment(seat);
  }

  addressOf(ws: WebSocket): string | undefined {
    return this.ctx.getTags(ws)[0];
  }

  send(ws: WebSocket, frame: Uint8Array): void {
    try {
      ws.send(frame);
    } catch {
      // It is closing. webSocketClose counts it as having left.
    }
  }

  close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
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

  /** The role of each person who logged in. Kept in the seats table. */
  readonly roles: RoleBook = {
    roleOf: (userId) =>
      this.ctx.storage.sql.exec<{ role: PeerRole }>('SELECT role FROM seats WHERE user_id = ?', userId).toArray()[0]
        ?.role ?? null,
    add: (userId, role) => {
      this.ctx.storage.sql.exec('INSERT INTO seats (user_id, role) VALUES (?, ?)', userId, role);
    },
    set: (userId, role) => {
      this.ctx.storage.sql.exec('UPDATE seats SET role = ? WHERE user_id = ?', role, userId);
    },
    gameMasterCount: () =>
      this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM seats WHERE role = 'gm'").one().count,
  };

  /**
   * The key that checks tokens. Rooms can be made only on a Worker with login set up, but when login
   * is taken away later, this is null. Meanwhile tokens are neither checked nor made (guests can still
   * come in).
   */
  sessionSecret(): string | null {
    return parseConfig(this.env).login?.sessionSecret ?? null;
  }

  /** One PUT can store up to the limit for each type. */
  assetUploadPolicy(): null {
    return null;
  }

  /**
   * While people are in the room, it is checked on, not deleted. The row is written only when the
   * room was empty, not each time someone more comes in.
   */
  occupied(nextCheckAt: number): void {
    this.ctx.storage.sql.exec('UPDATE room SET emptied_at = NULL WHERE emptied_at IS NOT NULL');
    void this.ctx.storage.setAlarm(nextCheckAt);
  }

  /** The next check moved, as when a token was renewed. */
  recheckAt(at: number): void {
    void this.ctx.storage.setAlarm(at);
  }

  /** Everyone has gone. The retention period is counted from here. */
  emptied(): void {
    this.ctx.storage.sql.exec('UPDATE room SET emptied_at = ?', Date.now());
    void this.ctx.storage.setAlarm(Date.now() + this.retentionMs());
  }

  /**
   * Brings the count and the GMs in the list up to date. The updates go out in order, and both are
   * worked out at the time they go out.
   * When the room has been deleted by then, nothing goes out.
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
   * Writes one data point to Workers Analytics Engine for something that happened in the room. The index
   * is the room key; the blobs are the Worker's host name, the event and its detail (the role, why the
   * connection closed, the game system); the double is its amount (the number of people, the seconds
   * connected, the number of changes written, the milliseconds a roll took). Nothing is written once
   * the room is gone.
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

  listed(): Promise<void> {
    return this.lobbyQueue;
  }

  bans(): Promise<BanList> {
    return this.banned.fresh();
  }

  defer(work: Promise<unknown>): void {
    this.ctx.waitUntil(work);
  }

  // ---- The room's row ----

  /** The room's row, or null when it has not been made or is gone. */
  private roomRow(): RoomRow | null {
    const sql = this.ctx.storage.sql;
    const tables = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room', 'deleting')")
      .toArray()
      .map((table) => table.name);
    // A room whose deletion has begun counts as gone, even when it is not deleted all the way.
    if (!tables.includes('room') || tables.includes('deleting')) return null;
    return sql
      .exec<RoomRow>('SELECT room_key, room_id, name, password_salt, password_hash, host, emptied_at FROM room')
      .one();
  }

  private retentionMs(): number {
    return parseConfig(this.env).roomRetentionSeconds * 1000;
  }

  private lobby() {
    return this.env.LOBBY.getByName(LOBBY_NAME);
  }
}
