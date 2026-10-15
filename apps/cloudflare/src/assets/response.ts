/** ブラウザや CDN に置いてよい最長の期間（7日） */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * SVG を開いたときに効かせる CSP。中に書かれたスクリプトを動かさず、外へ読みに行かせない。
 * 描くのに要る、埋め込みの画像（data:）と style 属性だけを通す
 */
const SVG_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/**
 * 配信する中身のヘッダー。部屋が消えるまで中身は変わらないので、長く置いてよい。
 *
 * Worker のキャッシュ（Cache API）に入れるため public にする。手元に返すときは privately で
 * private に替える。public のまま返すと、前に置いた CDN の規則によっては、トークンを付けない
 * 読み出しにまでキャッシュから返ってしまう
 */
export const objectHeaders = (object: R2Object): Headers => {
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}, immutable`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  // SVG は文書として開けばスクリプトが動く。<img> で読むぶんには CSP は効かず、もともと動かない
  if (object.httpMetadata?.contentType === 'image/svg+xml') {
    headers.set('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
  }
  return headers;
};

/** 手元に返す応答。ブラウザには置かせても、共有のキャッシュには置かせない */
export const privately = (response: Response): Response => {
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', `private, max-age=${MAX_AGE_SECONDS}, immutable`);
  return copy;
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
