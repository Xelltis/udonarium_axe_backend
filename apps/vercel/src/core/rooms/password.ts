import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';

/** The limit on the iterations that PBKDF2 on Workers accepts. */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface PasswordHash {
  salt: ArrayBuffer;
  hash: ArrayBuffer;
}

// Computed synchronously, so that no other message cuts in while checking.
const derive = (password: string, salt: ArrayBuffer): ArrayBuffer => {
  const bytes = pbkdf2Sync(password, new Uint8Array(salt), ITERATIONS, HASH_BYTES, 'sha256');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** Turns a room's password into a PBKDF2 hash, so that it is not stored as it is. */
export const hashPassword = (password: string): PasswordHash => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES)).buffer;
  return { salt, hash: derive(password, salt) };
};

/** Whether a password matches the hash. Comparing takes the same time wherever they differ. */
export const verifyPassword = (password: string, stored: PasswordHash): boolean =>
  timingSafeEqual(new Uint8Array(derive(password, stored.salt)), new Uint8Array(stored.hash));
