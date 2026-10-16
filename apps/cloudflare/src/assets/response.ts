import { assetHeaders } from '../core/assets/headers';

/** The headers for serving an object kept in R2. */
export const objectHeaders = (object: R2Object): Headers =>
  assetHeaders({
    type: object.httpMetadata?.contentType,
    size: object.size,
    etag: object.httpEtag,
    name: object.customMetadata?.name,
  });

/** Turns the range R2 cut out into the Content-Range and Content-Length that a 206 returns. */
export const setContentRange = (headers: Headers, range: R2Range, size: number): void => {
  // The range R2 returns holds even the fields it does not use, as undefined values.
  const { offset, length, suffix } = range as { offset?: number; length?: number; suffix?: number };
  const start = suffix === undefined ? (offset ?? 0) : size - suffix;
  const count = suffix ?? length ?? size - start;
  headers.set('Content-Range', `bytes ${start}-${start + count - 1}/${size}`);
  headers.set('Content-Length', String(count));
};
