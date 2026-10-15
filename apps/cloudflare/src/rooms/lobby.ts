import { DurableObject } from 'cloudflare:workers';

import type { RoomSummary } from '../../contracts/protocol';

/** 部屋の一覧を持つ Durable Object の名前。Worker ごとに1つだけ置く */
export const LOBBY_NAME = 'lobby';

/** 一覧で返す部屋の数の上限 */
const MAX_LISTED_ROOMS = 1000;

interface RoomRow extends Record<string, SqlStorageValue> {
  room_key: string;
  room_id: string;
  name: string;
  has_password: number;
  members: number;
  game_master: number;
}

/**
 * 部屋の一覧。部屋（RoomDurableObject）が、作られたとき・人が出入りしたとき・役割が変わったとき・
 * 消えたときに知らせてくる。D1 を使わないので、デプロイのときに作るものが増えない。
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
    // 部屋ごとの GM のユーザー ID。一覧を取った人が GM の部屋に印を付ける
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS game_masters (
      room_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (room_key, user_id)
    )`);
  }

  register(room: RoomSummary): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO rooms (room_key, room_id, name, has_password, members, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      room.roomKey,
      room.roomId,
      room.name,
      room.hasPassword ? 1 : 0,
      room.members,
      Date.now(),
    );
  }

  setMembers(roomKey: string, members: number): void {
    this.ctx.storage.sql.exec('UPDATE rooms SET members = ? WHERE room_key = ?', members, roomKey);
  }

  /** 部屋の GM を置き換える。一覧に無い部屋（消えたあとに届いた知らせ）のものは置かない */
  setGameMasters(roomKey: string, userIds: string[]): void {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM game_masters WHERE room_key = ?', roomKey);
    for (const userId of userIds) {
      sql.exec(
        `INSERT INTO game_masters (room_key, user_id)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM rooms WHERE room_key = ?)`,
        roomKey,
        userId,
        roomKey,
      );
    }
  }

  remove(roomKey: string): void {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_key = ?', roomKey);
    this.ctx.storage.sql.exec('DELETE FROM game_masters WHERE room_key = ?', roomKey);
  }

  /** 渡した鍵のうち、一覧にある部屋のもの。部屋がもう無いアセットを掃除するときに使う */
  known(roomKeys: string[]): string[] {
    if (roomKeys.length === 0) return [];
    return this.ctx.storage.sql
      .exec<{ room_key: string }>(
        `SELECT room_key FROM rooms WHERE room_key IN (${roomKeys.map(() => '?').join(', ')})`,
        ...roomKeys,
      )
      .toArray()
      .map((row) => row.room_key);
  }

  /** 作られた順。userId を渡せば、その人が GM の部屋に deletable を付ける */
  list(userId?: string): RoomSummary[] {
    return this.ctx.storage.sql
      .exec<RoomRow>(
        `SELECT room_key, room_id, name, has_password, members,
           EXISTS (SELECT 1 FROM game_masters
                   WHERE game_masters.room_key = rooms.room_key AND user_id = ?) AS game_master
         FROM rooms ORDER BY created_at, room_key LIMIT ?`,
        userId ?? '',
        MAX_LISTED_ROOMS,
      )
      .toArray()
      .map((row) => ({
        roomKey: row.room_key,
        roomId: row.room_id,
        name: row.name,
        hasPassword: row.has_password === 1,
        members: row.members,
        ...(row.game_master === 1 ? { deletable: true } : {}),
      }));
  }
}
