// nodejs_compat で使える node: のうち、部屋で使う同期の gzip と PBKDF2 だけの型。
// @types/node を入れると workers-types と大域の型がぶつかるので、要るものだけ書く。
declare module 'node:zlib' {
  interface ZlibOptions {
    /** 展開したあとの最大バイト数。超えると例外になる */
    maxOutputLength?: number;
  }
  export function gzipSync(data: Uint8Array): Uint8Array;
  export function gunzipSync(data: Uint8Array, options?: ZlibOptions): Uint8Array;
}

declare module 'node:crypto' {
  export function pbkdf2Sync(
    password: string,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: 'sha256',
  ): Uint8Array;
}
