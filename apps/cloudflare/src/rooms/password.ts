import { pbkdf2Sync } from 'node:crypto';

/** Workers の PBKDF2 が受ける回数の上限 */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface PasswordHash {
  salt: ArrayBuffer;
  hash: ArrayBuffer;
}

// 確かめるあいだに、ほかのメッセージが割り込まないよう、同期で計算する
const derive = (password: string, salt: ArrayBuffer): ArrayBuffer => {
  const bytes = pbkdf2Sync(password, new Uint8Array(salt), ITERATIONS, HASH_BYTES, 'sha256');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** 部屋のパスワードを、そのまま置かずに PBKDF2 のハッシュにする */
export const hashPassword = (password: string): PasswordHash => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES)).buffer;
  return { salt, hash: derive(password, salt) };
};

/** パスワードがハッシュと合うか。比べる時間は、どこで違っても同じにする */
export const verifyPassword = (password: string, stored: PasswordHash): boolean =>
  crypto.subtle.timingSafeEqual(derive(password, stored.salt), stored.hash);
