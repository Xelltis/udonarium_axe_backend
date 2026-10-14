/**
 * 配信のキャッシュ期間（7日）。中身は名前で決まるので古くならないが、
 * バケットの保持期間（30日）より長く CDN に残らないよう短めにする。
 */
const CACHE_CONTROL = 'public, max-age=604800, immutable';

/** 配信する中身のヘッダー */
export const objectHeaders = (object: R2Object): Headers => {
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', CACHE_CONTROL);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return headers;
};

/** R2 が切り出した範囲を、206 で返す Content-Range と Content-Length にする */
export const setContentRange = (headers: Headers, range: R2Range, size: number): void => {
  // R2 が返す範囲は、使っていない項目も undefined の値として持っている
  const { offset, length, suffix } = range as { offset?: number; length?: number; suffix?: number };
  const start = suffix === undefined ? (offset ?? 0) : size - suffix;
  const count = suffix ?? length ?? size - start;
  headers.set('Content-Range', `bytes ${start}-${start + count - 1}/${size}`);
  headers.set('Content-Length', String(count));
};
