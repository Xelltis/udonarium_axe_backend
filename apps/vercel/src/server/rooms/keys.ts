import type { RoomInit } from '../../core/http/backend.js';
import { hashPassword } from '../../core/rooms/password.js';
import type { PasswordHash } from '../../core/rooms/password.js';
import type { KeyOf, Redis } from '../redis.js';
import type { Fence } from './fence.js';
import { storeKeysOf } from './store.js';
import type { StoreKeys } from './store.js';

// What is kept in Redis for each room.
//
//   r:<key>:meta   HASH  roomKey, roomId, name, salt, hash (of the password, base64), host, createdAt,
//                        emptiedAt, deleting.
//   r:<key>:roles  HASH  user id → role (for each person who has come in logged in).
//   r:<key>:seats  HASH  connection id → JSON of the seat (who is in now, so that the server can ask
//                        whether they may store assets).
//   r:<key>:lease  STR   The room's owner (instance:epoch). The owner keeps extending it.
//   r:<key>:epoch  STR   A number raised each time the owner changes.
//   rooms:expiry   ZSET  room key → when to delete the room. While people are in, the owner keeps
//                        pushing it later (sweep.ts deletes the rooms).

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

/** What a room needs to make a seat, and what goes along with its log lines. */
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

/** Makes a room. Its maker becomes GM, and if nobody comes in, it goes away after the retention period. */
export const createRoom = async (
  redis: Redis,
  key: KeyOf,
  init: RoomInit,
  retentionSeconds: number
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

/** The room, or null when it has not been made, is being deleted, or is past its retention period. */
export const readRoomMeta = async (redis: Redis, key: KeyOf, roomKey: string): Promise<RoomMeta | null> => {
  const keys = roomKeysOf(key, roomKey);
  const [meta, wipeAt] = await Promise.all([redis.hGetAll(keys.meta), redis.zScore(expiryKeyOf(key), roomKey)]);
  if (!meta.roomKey || meta.deleting === '1') return null;
  // A room past its retention period counts as gone, even when deleting it is late.
  if (wipeAt !== null && wipeAt <= Date.now()) return null;
  return {
    roomKey,
    password: meta.salt && meta.hash ? { salt: bytesOf(meta.salt), hash: bytesOf(meta.hash) } : null,
    host: meta.host,
  };
};
