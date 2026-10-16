import { ASSET_NAME_HEADER } from '../../../contracts/protocol.js';

/** The longest a browser or a CDN may keep it (7 days). */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * The CSP that applies when an SVG is opened. It keeps scripts written inside from running and
 * from fetching anything from outside. It lets through only what drawing needs: embedded pictures
 * (data:) and the style attribute.
 */
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** What the headers for serving need to know about a stored asset. */
export interface AssetMeta {
  /** The type decided from the first bytes when it was stored; application/octet-stream when none. */
  type: string | undefined;
  size: number;
  /** The ETag, in quotes. */
  etag: string;
  /** The name it was stored with. Empty when there is none. */
  name: string | undefined;
}

/**
 * The headers for the contents served. The contents do not change until the room is deleted, so
 * they may be kept for a long time.
 *
 * They are public so that the contents go into the room server's cache (the Cache API in the
 * Cloudflare version). When they are sent back to whoever asked, privately changes them to private.
 * Sent back as public, depending on the rules of a CDN put in front, the cache would answer even
 * reads that carry no token.
 */
export const assetHeaders = (meta: AssetMeta): Headers => {
  const headers = new Headers();
  headers.set('Content-Type', meta.type ?? 'application/octet-stream');
  headers.set('Content-Length', String(meta.size));
  headers.set('ETag', meta.etag);
  headers.set('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}, immutable`);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Scripts in an SVG run when it is opened as a document. Read through <img>, the CSP has no
  // effect, and they do not run anyway.
  if (meta.type === 'image/svg+xml') {
    headers.set('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
  }
  // The name it was stored with. The catalog has no names, so whoever fetches it learns the name
  // from this.
  if (meta.name) headers.set(ASSET_NAME_HEADER, encodeURIComponent(meta.name));
  return headers;
};

/** The response sent back to whoever asked. A browser may keep it, but a shared cache may not. */
export const privately = (response: Response): Response => {
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', `private, max-age=${MAX_AGE_SECONDS}, immutable`);
  return copy;
};
