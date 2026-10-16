import type { RoomInit } from '../../core/http/backend.js';
import { hashPassword } from '../../core/rooms/password.js';
import type { PasswordHash } from '../../core/rooms/password.js';
import type { KeyOf, Redis } from '../redis.js';
import type { Fence } from './fence.js';
import { storeKeysOf } from './store.js';
import type { StoreKeys } from './store.js';

// 部屋ごとに Redis に置くもの。
//
//   r:<鍵>:meta    HASH  roomKey・roomId・name・salt・hash（パスワード、base64）・host・createdAt・emptiedAt・deleting
//   r:<鍵>:roles   HASH  ユーザー ID → 役割（ログインして入ったことのある人）
//   r:<鍵>:seats   HASH  接続の ID → 席の JSON（いま入っている人。アセットを置けるかを尋ねるため）
//   r:<鍵>:lease   STR   部屋の持ち主（インスタンス:epoch）。持ち主が延ばし続ける
//   r:<鍵>:epoch   STR   持ち主が替わるたびに増やす数
//   rooms:expiry   ZSET  部屋の鍵 → 消す時刻。人がいるあいだは持ち主が先へ延ばし続ける（sweep.ts が消す）

export interface RoomKeys extends StoreKeys, Fence {
  roles: string;
  seats: string;
  epoch: string;
}

export const roomKeysOf = (key: KeyOf, roomKey: string): RoomKeys => ({
  ...storeKeysOf(key, roomKey),
  meta: key('r', roomKey, 'meta'),
  roles: key('r', roomKey, 'roles'),
  seats: key('r', roomKey, 'seats'),
  lease: key('r', roomKey, 'lease'),
  epoch: key('r', roomKey, 'epoch'),
});

export const expiryKeyOf = (key: KeyOf): string => key('rooms', 'expiry');

/** 部屋の、席を作るのに要ることと、記録に添えるもの */
export interface RoomMeta {
  roomKey: string;
  password: PasswordHash | null;
  host: string;
}

const base64Of = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('base64');

const bytesOf = (text: string): ArrayBuffer => {
  const bytes = Buffer.from(text, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** 部屋を作る。作った人が GM になり、だれも入らなければ保持期間で消える */
export const createRoom = async (
  redis: Redis,
  key: KeyOf,
  init: RoomInit,
  retentionSeconds: number,
): Promise<boolean> => {
  const keys = roomKeysOf(key, init.roomKey);
  const password = init.password ? hashPassword(init.password) : null;
  const now = Date.now();
  await redis
    .multi()
    .hSet(keys.meta, {
      roomKey: init.roomKey,
      roomId: init.roomId,
      name: init.name,
      salt: password ? base64Of(password.salt) : '',
      hash: password ? base64Of(password.hash) : '',
      host: init.host,
      createdAt: String(now),
      emptiedAt: String(now),
    })
    .hSet(keys.roles, init.creatorUserId, 'gm')
    .zAdd(expiryKeyOf(key), { score: now + retentionSeconds * 1000, value: init.roomKey })
    .exec();
  return password !== null;
};

/** 部屋。作られていないか、消しはじめたか、保持期間を過ぎていれば null */
export const readRoomMeta = async (
  redis: Redis,
  key: KeyOf,
  roomKey: string,
): Promise<RoomMeta | null> => {
  const keys = roomKeysOf(key, roomKey);
  const [meta, wipeAt] = await Promise.all([
    redis.hGetAll(keys.meta),
    redis.zScore(expiryKeyOf(key), roomKey),
  ]);
  if (!meta.roomKey || meta.deleting === '1') return null;
  // 保持期間を過ぎた部屋は、消すのが遅れていても、もう無いものとする
  if (wipeAt !== null && wipeAt <= Date.now()) return null;
  return {
    roomKey,
    password:
      meta.salt && meta.hash ? { salt: bytesOf(meta.salt), hash: bytesOf(meta.hash) } : null,
    host: meta.host,
  };
};
