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
}

/**
 * 部屋の一覧。部屋（RoomDurableObject）が、作られたとき・人が出入りしたとき・消えたときに知らせてくる。
 * D1 を使わないので、デプロイのときに作るものが増えない。
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

  remove(roomKey: string): void {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_key = ?', roomKey);
  }

  /** 作られた順 */
  list(): RoomSummary[] {
    return this.ctx.storage.sql
      .exec<RoomRow>(
        `SELECT room_key, room_id, name, has_password, members FROM rooms
         ORDER BY created_at, room_key LIMIT ?`,
        MAX_LISTED_ROOMS,
      )
      .toArray()
      .map((row) => ({
        roomKey: row.room_key,
        roomId: row.room_id,
        name: row.name,
        hasPassword: row.has_password === 1,
        members: row.members,
      }));
  }
}
