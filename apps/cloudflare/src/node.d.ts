// Types for only the synchronous gzip, PBKDF2, HMAC and SHA-256, out of the node: modules nodejs_compat offers.
// Installing @types/node makes its global types clash with workers-types, so only what is needed is here.
declare module 'node:zlib' {
  interface ZlibOptions {
    /** The most bytes there may be after decompressing. Going over throws. */
    maxOutputLength?: number;
  }
  export function gzipSync(data: Uint8Array): Uint8Array;
  export function gunzipSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: 'sha256'): Hash;
  interface Hmac {
    update(data: string): Hmac;
    digest(): Uint8Array;
  }
  export function createHmac(algorithm: 'sha256', key: string): Hmac;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function pbkdf2Sync(
    password: string,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: 'sha256'
  ): Uint8Array;
}
