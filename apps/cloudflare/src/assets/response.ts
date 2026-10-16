import { assetHeaders } from '../core/assets/headers';

/** R2 に置いたものの、配信のヘッダー */
export const objectHeaders = (object: R2Object): Headers =>
  assetHeaders({
    type: object.httpMetadata?.contentType,
    size: object.size,
    etag: object.httpEtag,
    name: object.customMetadata?.name,
  });

/** R2 が切り出した範囲を、206 で返す Content-Range と Content-Length にする */
export const setContentRange = (headers: Headers, range: R2Range, size: number): void => {
  // R2 が返す範囲は、使っていない項目も undefined の値として持っている
  const { offset, length, suffix } = range as { offset?: number; length?: number; suffix?: number };
  const start = suffix === undefined ? (offset ?? 0) : size - suffix;
  const count = suffix ?? length ?? size - start;
  headers.set('Content-Range', `bytes ${start}-${start + count - 1}/${size}`);
  headers.set('Content-Length', String(count));
};
