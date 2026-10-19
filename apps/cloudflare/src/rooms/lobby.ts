import { DurableObject } from 'cloudflare:workers';

import type { RoomSummary } from '../../contracts/protocol';
import { MAX_ADMIN_ROOMS } from '../core/http/backend';
import type { AdminRoom, RoomCreator } from '../core/http/backend';

/** The name of the Durable Object that holds the room list. There is only one for each Worker. */
export const LOBBY_NAME = 'lobby';

/** The limit on how many rooms the list returns. When there are more, the newest are returned. */
const MAX_LISTED_ROOMS = 1000;

/** The columns for the list and for a lookup by key. The first ? is the user id checked for being a GM. */
const SUMMARY_COLUMNS = `SELECT room_key, room_id, name, has_password, members,
       EXISTS (SELECT 1 FROM game_masters
               WHERE game_masters.room_key = rooms.room_key AND user_id = ?) AS game_master
     FROM rooms`;

/** Turns a row of the list into a room summary. */
const summaryOf = (row: RoomRow): RoomSummary => ({
  roomKey: row.room_key,
  roomId: row.room_id,
  name: row.name,
  hasPassword: row.has_password === 1,
  members: row.members,
  ...(row.game_master === 1 ? { deletable: true } : {}),
});

/** How many values one statement can bind. The SQLite of Durable Objects allows up to 100. */
const MAX_BINDINGS = 100;

interface RoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  room_id: string;
  name: string;
  has_password: number;
  members: number;
  game_master: number;
}

interface AdminRoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  room_id: string;
  name: string;
  has_password: number;
  members: number;
  created_at: number;
  account_key: string | null;
  address: string | null;
}

/**
 * The room list. A room (RoomDurableObject) tells it when the room is made, when someone joins or
 * leaves, when a role changes, and when the room is gone. It does not use D1, so a deploy has nothing
 * more to make.
 */
export class LobbyDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      room_key TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      has_password INTEGER NOT NULL,
      members INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // The user ids of each room's GMs. They mark the rooms where the person asking for the list is a GM.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS game_masters (
      room_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (room_key, user_id)
    )`);
    // Who made each room, for the operator. A table of its own, so that a list made before it was
    // kept needs nothing changed.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS creators (
      room_key TEXT PRIMARY KEY,
      account_key TEXT NOT NULL,
      address TEXT NOT NULL
    )`);
  }

  register(room: RoomSummary, creator?: RoomCreator): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT OR REPLACE INTO rooms (room_key, room_id, name, has_password, members, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      room.roomKey,
      room.roomId,
      room.name,
      room.hasPassword ? 1 : 0,
      room.members,
      Date.now()
    );
    if (creator) {
      sql.exec(
        'INSERT OR REPLACE INTO creators (room_key, account_key, address) VALUES (?, ?, ?)',
        room.roomKey,
        creator.accountKey,
        creator.address
      );
    }
  }

  setMembers(roomKey: string, members: number): void {
    this.ctx.storage.sql.exec('UPDATE rooms SET members = ? WHERE room_key = ?', members, roomKey);
  }

  /** Replaces a room's GMs. Nothing is kept for a room not in the list (news that came after it was gone). */
  setGameMasters(roomKey: string, userIds: string[]): void {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM game_masters WHERE room_key = ?', roomKey);
    for (const userId of userIds) {
      sql.exec(
        `INSERT INTO game_masters (room_key, user_id)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM rooms WHERE room_key = ?)`,
        roomKey,
        userId,
        roomKey
      );
    }
  }

  remove(roomKey: string): void {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_key = ?', roomKey);
    this.ctx.storage.sql.exec('DELETE FROM game_masters WHERE room_key = ?', roomKey);
    this.ctx.storage.sql.exec('DELETE FROM creators WHERE room_key = ?', roomKey);
  }

  /** The rooms for the operator, newest first, up to MAX_ADMIN_ROOMS, with who made them. */
  all(): AdminRoom[] {
    return this.ctx.storage.sql
      .exec<AdminRoomRow>(
        `SELECT rooms.room_key, room_id, name, has_password, members, created_at, account_key, address
         FROM rooms LEFT JOIN creators ON creators.room_key = rooms.room_key
         ORDER BY created_at DESC, rooms.room_key LIMIT ?`,
        MAX_ADMIN_ROOMS
      )
      .toArray()
      .map((row) => ({
        roomKey: row.room_key,
        roomId: row.room_id,
        name: row.name,
        hasPassword: row.has_password === 1,
        members: row.members,
        createdAt: row.created_at,
        creator: row.account_key === null ? null : { accountKey: row.account_key, address: row.address as string },
      }));
  }

  /** The keys of the rooms with someone in them. */
  occupied(): string[] {
    return this.ctx.storage.sql
      .exec<{ room_key: string }>('SELECT room_key FROM rooms WHERE members > 0')
      .toArray()
      .map((row) => row.room_key);
  }

  /**
   * The given keys whose rooms are in the list. Used when sweeping away assets whose room is gone.
   * A page can hold more than 100 rooms, so it asks MAX_BINDINGS at a time.
   */
  known(roomKeys: string[]): string[] {
    const found: string[] = [];
    for (let start = 0; start < roomKeys.length; start += MAX_BINDINGS) {
      const part = roomKeys.slice(start, start + MAX_BINDINGS);
      const rows = this.ctx.storage.sql
        .exec<{ room_key: string }>(
          `SELECT room_key FROM rooms WHERE room_key IN (${part.map(() => '?').join(', ')})`,
          ...part
        )
        .toArray();
      found.push(...rows.map((row) => row.room_key));
    }
    return found;
  }

  /**
   * Up to MAX_LISTED_ROOMS, newest first. Given a userId, it adds deletable to the rooms where that
   * person is a GM, and always includes those rooms even past the count (so that a room the person can
   * delete does not drop out of the list).
   */
  list(userId?: string): RoomSummary[] {
    const sql = this.ctx.storage.sql;
    const newest = sql
      .exec<RoomRow>(`${SUMMARY_COLUMNS} ORDER BY created_at DESC, room_key LIMIT ?`, userId ?? '', MAX_LISTED_ROOMS)
      .toArray();
    const listed = new Set(newest.map((row) => row.room_key));
    const mine = userId
      ? sql
          .exec<RoomRow>(
            `${SUMMARY_COLUMNS} WHERE room_key IN (SELECT room_key FROM game_masters WHERE user_id = ?)`,
            userId,
            userId
          )
          .toArray()
          .filter((row) => !listed.has(row.room_key))
      : [];
    return [...newest, ...mine].map(summaryOf);
  }

  /**
   * The one room looked up by key. Even an old room left out of the list can be found. Null when there
   * is none. Given a userId, it adds deletable when that person is a GM.
   */
  find(roomKey: string, userId?: string): RoomSummary | null {
    const [row] = this.ctx.storage.sql
      .exec<RoomRow>(`${SUMMARY_COLUMNS} WHERE room_key = ?`, userId ?? '', roomKey)
      .toArray();
    return row ? summaryOf(row) : null;
  }
}
