import type { Context, ErrorHandler } from 'hono';

import { ConfigError } from '../config/login.js';

/**
 * An error sent back with the body `{"error": "<code>"}`. Kept the same as the table under エラー in
 * docs/reference/server-api.md.
 */
export type ErrorCode =
  | 'invalid-id'
  | 'invalid-request'
  | 'invalid-grant'
  | 'login-required'
  | 'login-unavailable'
  | 'banned'
  | 'paused'
  | 'forbidden'
  | 'passkey-required'
  | 'reauth-required'
  | 'invalid-challenge'
  | 'passkey-refused'
  | 'passkey-exists'
  | 'no-passkeys'
  | 'last-passkey'
  | 'too-many-passkeys'
  | 'blocked'
  | 'room-storage-full'
  | 'hash-mismatch'
  | 'origin-not-allowed'
  | 'not-found'
  | 'not-game-master'
  | 'not-a-player'
  | 'asset-token-required'
  | 'room-not-found'
  | 'length-required'
  | 'precondition-failed'
  | 'too-large'
  | 'unsupported-type'
  | 'upgrade-required'
  | 'rate-limited'
  | 'config-invalid'
  | 'internal-error';

/** An error response made outside a Hono context. */
export const failure = (status: number, error: ErrorCode): Response => Response.json({ error }, { status });

/** The refusals that come from the operator: they carry where to ask about them, when one is given. */
const FROM_THE_OPERATOR: ReadonlySet<ErrorCode> = new Set(['banned', 'paused']);

export const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 411 | 412 | 413 | 415 | 426 | 429 | 451 | 500 | 503,
  error: ErrorCode
) => {
  const contact = FROM_THE_OPERATOR.has(error) ? contactOf(c) : null;
  return c.json(contact ? { error, contact } : { error }, status);
};

/**
 * Where someone turned away can ask (ADMIN_CONTACT_URL), or null. Only asked once the settings have
 * been read: a ban or a stop is found only after that.
 */
const contactOf = (c: Context): string | null => (c.var as { config: { contactUrl: string | null } }).config.contactUrl;

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    return fail(c, 500, 'config-invalid');
  }
  console.error('Unhandled error:', err);
  return fail(c, 500, 'internal-error');
};
