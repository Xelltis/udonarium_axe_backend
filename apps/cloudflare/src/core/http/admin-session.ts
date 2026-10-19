import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { randomText } from '../auth/secrets.js';
import { readToken, signToken } from '../auth/tokens.js';
import type { Claims } from '../auth/tokens.js';
import type { AdminConfig } from '../config/admin.js';
import type { LoginConfig } from '../config/login.js';
import type { ServerEnv } from './backend.js';
import { fail } from './errors.js';

// The operator's session on the dashboard. It lives in an HttpOnly cookie (no script on the page
// can read it), signed with SESSION_SECRET, and is checked on every call:
//
// - Discord let the operator in, and the operator is still in ADMIN_DISCORD_IDS.
// - Its generation is the store's (raising the generation ends every session).
// - Until a passkey confirms it is the operator, it may do nothing but that (stage discord).
// - It ends after SESSION_IDLE_SECONDS without a call, and SESSION_MAX_SECONDS after Discord at most.
// - What cannot be undone asks for the passkey again if it last confirmed over STEP_UP_SECONDS ago.

type AdminContext = Context<ServerEnv>;
export type AdminSession = Claims<'admin'>;

/** How long a session lasts without a call (seconds). Each call puts it off. */
export const SESSION_IDLE_SECONDS = 30 * 60;
/** How long a session lasts at most, from the Discord login (seconds). */
export const SESSION_MAX_SECONDS = 12 * 60 * 60;
/** How long after Discord a passkey may still be confirmed (seconds). */
export const DISCORD_STAGE_SECONDS = 10 * 60;
/** How recently a passkey must have confirmed it before what cannot be undone (seconds). */
export const STEP_UP_SECONDS = 5 * 60;

/** The header every call to the dashboard's API carries. A page on another site cannot send it. */
export const ADMIN_REQUEST_HEADER = 'X-Admin-Request';

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Whether the dashboard was reached over HTTPS, where cookies are marked Secure and prefixed __Host-. */
const overHttps = (c: AdminContext) => new URL(c.req.url).protocol === 'https:';

/** The session cookie's name. __Host- keeps it to this host, over HTTPS (not on a local server). */
const sessionCookie = (c: AdminContext) => (overHttps(c) ? '__Host-axe-admin' : 'axe-admin');
/** The cookie that ties the way back from Discord to the browser that set out. */
export const loginCookie = (c: AdminContext) => (overHttps(c) ? '__Host-axe-admin-login' : 'axe-admin-login');

/** The settings of the dashboard's cookies. SameSite=Lax only where a way back from Discord needs it. */
export const cookieOptions = (c: AdminContext, sameSite: 'Strict' | 'Lax', maxAge: number) => ({
  httpOnly: true,
  secure: overHttps(c),
  sameSite,
  path: '/',
  maxAge,
});

/** Where the dashboard is, for passkeys: its origin, and its host name as the site. */
export const siteOf = (c: AdminContext) => {
  const url = new URL(c.req.url);
  return { origin: url.origin, rpId: url.hostname };
};

const secretOf = (c: AdminContext) => (c.var.config.login as LoginConfig).sessionSecret;

/** What a session says, without when its cookie runs out (which is worked out again each time). */
const fieldsOf = ({ aud, sub, name, sid, stage, epoch, start, verified }: AdminSession): Omit<AdminSession, 'exp'> => ({
  aud,
  sub,
  name,
  sid,
  stage,
  epoch,
  start,
  verified,
});

/** Sets the session's cookie, for as long as it may last from now. */
export const keepSession = (c: AdminContext, session: Omit<AdminSession, 'exp'>): void => {
  const now = nowSeconds();
  const seconds =
    session.stage === 'discord'
      ? session.start + DISCORD_STAGE_SECONDS - now
      : Math.min(SESSION_IDLE_SECONDS, session.start + SESSION_MAX_SECONDS - now);
  setCookie(
    c,
    sessionCookie(c),
    signToken<'admin'>(session, seconds, secretOf(c)),
    cookieOptions(c, 'Strict', seconds)
  );
};

/** Begins a session once Discord has let an operator in: it may only confirm a passkey yet. */
export const beginSession = async (c: AdminContext, discordId: string, name: string): Promise<void> => {
  keepSession(c, {
    aud: 'admin',
    sub: discordId,
    name,
    sid: randomText(16),
    stage: 'discord',
    epoch: await c.var.backend.moderation.admin.adminEpoch(),
    start: nowSeconds(),
    verified: 0,
  });
};

export const endSession = (c: AdminContext): void => {
  deleteCookie(c, sessionCookie(c), { path: '/', secure: overHttps(c) });
};

/** The session each call came with, once it has been checked. */
const sessions = new WeakMap<Request, AdminSession>();

export const sessionOf = (c: AdminContext): AdminSession => sessions.get(c.req.raw) as AdminSession;

/**
 * Lets through only a call made by the dashboard's page: with the header, and from this origin when
 * the browser says where from. A form or a page on another site can do neither.
 */
export const fromDashboard: MiddlewareHandler<ServerEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (c.req.header(ADMIN_REQUEST_HEADER) !== '1' || (origin !== undefined && origin !== siteOf(c).origin)) {
    return fail(c, 403, 'forbidden');
  }
  return next();
};

/**
 * Lets through only a call with a session that is still good, and puts its idle end off. 401
 * login-required otherwise (and the cookie is taken away).
 */
export const sessionRequired: MiddlewareHandler<ServerEnv> = async (c, next) => {
  const { config, backend } = c.var;
  const token = getCookie(c, sessionCookie(c));
  const session = token ? readToken(token, 'admin', secretOf(c)) : null;
  const good =
    session !== null &&
    // The dashboard is there only while there are operators (privately), so admin is set.
    (config.admin as AdminConfig).discordIds.includes(session.sub) &&
    session.epoch === (await backend.moderation.admin.adminEpoch());
  if (!good) {
    endSession(c);
    return fail(c, 401, 'login-required');
  }
  sessions.set(c.req.raw, session);
  if (session.stage === 'passkey') keepSession(c, fieldsOf(session));
  return next();
};

/** Lets through only a session a passkey has confirmed. 403 passkey-required otherwise. */
export const passkeyRequired: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (sessionOf(c).stage !== 'passkey') return fail(c, 403, 'passkey-required');
  return next();
};

/**
 * Lets through what cannot be undone only when a passkey confirmed it recently. 403 reauth-required
 * otherwise, and the page asks for the passkey again.
 */
export const recentPasskeyRequired: MiddlewareHandler<ServerEnv> = async (c, next) => {
  const { stage, verified } = sessionOf(c);
  if (stage !== 'passkey' || nowSeconds() - verified > STEP_UP_SECONDS) return fail(c, 403, 'reauth-required');
  return next();
};

/** Marks the session as confirmed by a passkey now. */
export const confirmSession = (c: AdminContext): void => {
  const confirmed: Omit<AdminSession, 'exp'> = { ...fieldsOf(sessionOf(c)), stage: 'passkey', verified: nowSeconds() };
  sessions.set(c.req.raw, { ...confirmed, exp: 0 });
  keepSession(c, confirmed);
};
