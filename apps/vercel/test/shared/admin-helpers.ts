import { signToken } from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';
import { ADMIN_ID, SESSION_SECRET, freshIp } from './helpers.js';

// Calling the operator's dashboard as its page does: with the header it sends, and the session
// cookie that Discord and a passkey leave.

export const ADMIN = 'https://backend.example/admin';

/** The name of the session cookie over HTTPS. */
export const SESSION_COOKIE = '__Host-axe-admin';

export interface SessionOptions {
  stage?: 'discord' | 'passkey';
  /** Discord user id. */
  sub?: string;
  sid?: string;
  /** When Discord let them in, and when a passkey last confirmed it (Unix seconds). */
  start?: number;
  verified?: number;
  /** The generation of sessions; the store’s by default. */
  epoch?: number;
  /** How long the cookie's token lasts (seconds). */
  seconds?: number;
}

/** The session cookie of an operator, as though Discord (and, unless told otherwise, a passkey) had just let them in. */
export const sessionCookieOf = async (options: SessionOptions = {}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const stage = options.stage ?? 'passkey';
  const token = signToken<'admin'>(
    {
      aud: 'admin',
      sub: options.sub ?? ADMIN_ID,
      name: 'Operator',
      sid: options.sid ?? crypto.randomUUID(),
      stage,
      epoch: options.epoch ?? (await harness.adminEpoch()),
      start: options.start ?? now,
      verified: options.verified ?? (stage === 'passkey' ? now : 0),
    },
    options.seconds ?? 600,
    SESSION_SECRET
  );
  return `${SESSION_COOKIE}=${token}`;
};

export interface AdminCall {
  method?: string;
  body?: unknown;
  /** The cookie to send. A session confirmed just now by default; null for none. */
  cookie?: string | null;
  ip?: string;
  headers?: Record<string, string>;
  env?: Record<string, string | undefined>;
}

/** Calls the dashboard's API as its page does. */
export const callAdmin = async (path: string, init: AdminCall = {}): Promise<Response> => {
  const cookie = init.cookie === undefined ? await sessionCookieOf() : init.cookie;
  const request = new Request(`${ADMIN}/api/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'X-Admin-Request': '1',
      'CF-Connecting-IP': init.ip ?? freshIp(),
      ...(cookie === null ? {} : { Cookie: cookie }),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
  return init.env ? harness.fetchWith(request, init.env) : harness.fetch(request);
};

/**
 * The session cookie a response leaves (its name=value), or null when it sets none or takes it away.
 * The last one set counts, as in a browser.
 */
export const sessionSetBy = (res: Response): string | null => {
  const set = res.headers.getSetCookie().findLast((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  if (!set) return null;
  const pair = set.split(';')[0];
  return pair === `${SESSION_COOKIE}=` || /Max-Age=0/i.test(set) ? null : pair;
};
