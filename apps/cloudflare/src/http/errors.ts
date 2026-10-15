import type { Context, ErrorHandler } from 'hono';

import { ConfigError } from '../config';

/** 本文 `{"error": "<コード>"}` で返すエラー。README の表と揃える */
export type ErrorCode =
  | 'invalid-id'
  | 'invalid-request'
  | 'invalid-grant'
  | 'login-required'
  | 'login-unavailable'
  | 'blocked'
  | 'hash-mismatch'
  | 'origin-not-allowed'
  | 'not-found'
  | 'not-game-master'
  | 'room-not-found'
  | 'length-required'
  | 'precondition-failed'
  | 'too-large'
  | 'unsupported-type'
  | 'upgrade-required'
  | 'rate-limited'
  | 'config-invalid'
  | 'internal-error';

export const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 411 | 412 | 413 | 415 | 426 | 429 | 451 | 500 | 503,
  error: ErrorCode,
) => c.json({ error }, status);

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    return fail(c, 500, 'config-invalid');
  }
  console.error('Unhandled error:', err);
  return fail(c, 500, 'internal-error');
};
