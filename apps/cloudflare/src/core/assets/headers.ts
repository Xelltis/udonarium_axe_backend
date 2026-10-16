import { ASSET_NAME_HEADER } from '../../../contracts/protocol.js';

/** ブラウザや CDN に置いてよい最長の期間（7日） */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * SVG を開いたときに効かせる CSP。中に書かれたスクリプトを動かさず、外へ読みに行かせない。
 * 描くのに要る、埋め込みの画像（data:）と style 属性だけを通す
 */
const SVG_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** 置いてあるアセットについて、配信のヘッダーに要ること */
export interface AssetMeta {
  /** 置いたときに先頭のバイトで決めた形式。無ければ application/octet-stream */
  type: string | undefined;
  size: number;
  /** 引用符付きの ETag */
  etag: string;
  /** 置いたときの名前。無ければ空 */
  name: string | undefined;
}

/**
 * 配信する中身のヘッダー。部屋が消えるまで中身は変わらないので、長く置いてよい。
 *
 * 部屋のサーバーのキャッシュ（Cloudflare 版の Cache API）に入れるため public にする。手元に返すときは
 * privately で private に替える。public のまま返すと、前に置いた CDN の規則によっては、トークンを
 * 付けない読み出しにまでキャッシュから返ってしまう
 */
export const assetHeaders = (meta: AssetMeta): Headers => {
  const headers = new Headers();
  headers.set('Content-Type', meta.type ?? 'application/octet-stream');
  headers.set('Content-Length', String(meta.size));
  headers.set('ETag', meta.etag);
  headers.set('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}, immutable`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  // SVG は文書として開けばスクリプトが動く。<img> で読むぶんには CSP は効かず、もともと動かない
  if (meta.type === 'image/svg+xml') {
    headers.set('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
  }
  // 置いたときの名前。カタログには名前が無いので、取りに来た人はこれで名前を知る
  if (meta.name) headers.set(ASSET_NAME_HEADER, encodeURIComponent(meta.name));
  return headers;
};

/** 手元に返す応答。ブラウザには置かせても、共有のキャッシュには置かせない */
export const privately = (response: Response): Response => {
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', `private, max-age=${MAX_AGE_SECONDS}, immutable`);
  return copy;
};
