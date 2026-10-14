/** ブラウザや CDN に置いてよい最長の期間（7日） */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * SVG を開いたときに効かせる CSP。中に書かれたスクリプトを動かさず、外へ読みに行かせない。
 * 描くのに要る、埋め込みの画像（data:）と style 属性だけを通す
 */
const SVG_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/**
 * 保持期間のうち、まだ残っている秒数。過ぎていれば 0 以下。
 *
 * ライフサイクル規則は期限を過ぎてから消すまでに間があくので、期限を過ぎたものはもう無いものとして
 * 扱う。そうしておけば、アップロードした人が次に部屋を読み込んだとき確実に上げ直せる。
 */
export const remainingSeconds = (object: R2Object, retentionSeconds: number): number =>
  retentionSeconds - Math.floor((Date.now() - object.uploaded.getTime()) / 1000);

/**
 * 配信する中身のヘッダー。
 *
 * max-age は受け取った時点から数えるので、残りの保持期間で頭打ちにする。そうしないと、バケットから
 * 消えたあともキャッシュが「ある」と答え続け、上げ直されなくなる。
 */
export const objectHeaders = (object: R2Object, remaining: number): Headers => {
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  headers.set(
    'Cache-Control',
    `public, max-age=${Math.min(MAX_AGE_SECONDS, remaining)}, immutable`,
  );
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // SVG は文書として開けばスクリプトが動く。<img> で読むぶんには CSP は効かず、もともと動かない
  if (object.httpMetadata?.contentType === 'image/svg+xml') {
    headers.set('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
  }
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
