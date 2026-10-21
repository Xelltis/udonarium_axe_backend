import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { maxLength, number, object, pipe, regex, safeParse, string } from 'valibot';

import { verifyAssertion, verifyRegistration } from '../../admin/webauthn.js';
import type { Passkey, PasskeyAlgorithm } from '../../admin/webauthn.js';
import { authorizeUrl, fetchProfile } from '../../auth/discord.js';
import { randomText, sameText } from '../../auth/secrets.js';
import { LOGIN_STATE_SECONDS, base64url, readToken, signToken } from '../../auth/tokens.js';
import type { AdminConfig } from '../../config/admin.js';
import type { LoginConfig } from '../../config/login.js';
import { ADMIN_DENIED, ADMIN_LOGIN } from '../../moderation/alerts.js';
import {
  STEP_UP_SECONDS,
  beginSession,
  confirmSession,
  cookieOptions,
  endSession,
  loginCookie,
  passkeyRequired,
  recentPasskeyRequired,
  sessionOf,
  siteOf,
} from '../admin-session.js';
import type { AdminSession } from '../admin-session.js';
import type { ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { note } from '../moderation.js';

// How an operator gets into the dashboard: Discord first (only those in ADMIN_DISCORD_IDS, with
// Discord's two-step login on), then a passkey of theirs. An operator with no passkey yet registers
// one in place of confirming it (as may one in ADMIN_PASSKEY_RESET, who has lost every device).

type AdminContext = Context<ServerEnv>;

/** How long a passkey challenge can be answered for (seconds). */
const CHALLENGE_SECONDS = 5 * 60;
/** How long the browser is given to make or use a passkey (milliseconds). */
const PASSKEY_TIMEOUT_MS = 2 * 60 * 1000;
/** How many passkeys one operator may have. */
export const MAX_PASSKEYS = 10;
/** The name the dashboard goes by, shown when a passkey is made. */
const SITE_NAME = '部屋のサーバーの管理';

const base64urlText = pipe(string(), maxLength(16_384), regex(/^[A-Za-z0-9_-]*$/));

const registrationSchema = object({
  token: string(),
  name: pipe(string(), maxLength(60)),
  credential: object({
    id: base64urlText,
    clientDataJSON: base64urlText,
    authenticatorData: base64urlText,
    publicKey: base64urlText,
    algorithm: number(),
  }),
});

const assertionSchema = object({
  token: string(),
  credential: object({
    id: base64urlText,
    clientDataJSON: base64urlText,
    authenticatorData: base64urlText,
    signature: base64urlText,
  }),
});

/** A passkey as the dashboard shows it (without its key). */
export interface PasskeySummary {
  id: string;
  name: string;
  algorithm: PasskeyAlgorithm;
  createdAt: number;
  usedAt: number | null;
}

/** Who is logged in, and what they may do yet. */
export interface AdminSessionResponse {
  discordId: string;
  name: string;
  /** discord until a passkey has confirmed it is the operator; passkey after. */
  stage: AdminSession['stage'];
  /** How many passkeys the operator has. */
  passkeys: number;
  /** Whether a passkey may be registered now without confirming one first. */
  mayRegister: boolean;
  /** When a passkey last confirmed it (Unix milliseconds). 0 before any. */
  verifiedAt: number;
}

const summaryOf = ({ id, name, algorithm, createdAt, usedAt }: Passkey): PasskeySummary => ({
  id,
  name,
  algorithm,
  createdAt,
  usedAt,
});

const secretOf = (c: AdminContext) => (c.var.config.login as LoginConfig).sessionSecret;
const store = (c: AdminContext) => c.var.backend.moderation.admin;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const callbackOf = (c: AdminContext) => `${siteOf(c).origin}/admin/login/callback`;

/** Back to the dashboard, with why the operator was turned away in the fragment (which no log keeps). */
const backToDashboard = (c: AdminContext, denied?: string) =>
  c.redirect(denied ? `/admin#denied=${denied}` : '/admin', 302);

/** Writes down what an operator did, with who they are. */
export const noteAdmin = (c: AdminContext, detail: string, extra: { roomKey?: string } = {}) => {
  const { sub, name } = sessionOf(c);
  note(c, { kind: 'admin', accountKey: `discord:${sub}`, name, detail, ...extra });
};

/**
 * Whether a passkey may be registered now. Before a passkey has confirmed the session, only an
 * operator with none (or one let through ADMIN_PASSKEY_RESET) may; after, one confirmed recently.
 */
const registrationRefusal = (c: AdminContext, passkeys: Passkey[]): Response | null => {
  const session = sessionOf(c);
  if (passkeys.length >= MAX_PASSKEYS) return fail(c, 409, 'too-many-passkeys');
  if (session.stage === 'passkey') {
    return nowSeconds() - session.verified > STEP_UP_SECONDS ? fail(c, 403, 'reauth-required') : null;
  }
  const { passkeyReset } = c.var.config.admin as AdminConfig;
  return passkeys.length === 0 || passkeyReset.includes(session.sub) ? null : fail(c, 403, 'passkey-required');
};

/** A challenge for a passkey, signed for this session and purpose. */
const challengeFor = (c: AdminContext, purpose: 'register' | 'confirm') => {
  const challenge = randomText(32);
  const token = signToken<'admin-challenge'>(
    { aud: 'admin-challenge', sid: sessionOf(c).sid, purpose, challenge },
    CHALLENGE_SECONDS,
    secretOf(c)
  );
  return { challenge, token };
};

/**
 * The challenge a passkey's answer came with, when it was given to this session for this purpose and
 * has not been answered before. Null otherwise.
 */
const takeChallenge = async (c: AdminContext, token: string, purpose: 'register' | 'confirm') => {
  const given = readToken(token, 'admin-challenge', secretOf(c));
  if (!given || given.sid !== sessionOf(c).sid || given.purpose !== purpose) return null;
  return (await store(c).takeChallenge(given.challenge, CHALLENGE_SECONDS * 1000)) ? given.challenge : null;
};

/** Confirms the session, and writes down the login when it is the first confirmation of this session. */
const confirm = (c: AdminContext) => {
  const first = sessionOf(c).stage === 'discord';
  confirmSession(c);
  if (first) noteAdmin(c, ADMIN_LOGIN);
};

/** The way in through Discord. It stands before the API's checks: the browser opens it as a page. */
export const adminLoginRoutes = (admin: Hono<ServerEnv>): void => {
  admin.get('/login', async (c) => {
    const { config, backend } = c.var;
    if (!config.login) return backToDashboard(c, 'login-unavailable');
    if (!(await backend.limit(c.req.raw, 'auth'))) return backToDashboard(c, 'rate-limited');
    const nonce = randomText(16);
    setCookie(c, loginCookie(c), nonce, cookieOptions(c, 'Lax', LOGIN_STATE_SECONDS));
    const state = signToken<'admin-login'>(
      { aud: 'admin-login', nonce },
      LOGIN_STATE_SECONDS,
      config.login.sessionSecret
    );
    return c.redirect(authorizeUrl(config.login, callbackOf(c), state), 302);
  });

  admin.get('/login/callback', async (c) => {
    const { config, backend } = c.var;
    if (!config.login) return backToDashboard(c, 'login-unavailable');
    const state = readToken(c.req.query('state') ?? '', 'admin-login', config.login.sessionSecret);
    const nonce = getCookie(c, loginCookie(c));
    deleteCookie(c, loginCookie(c), { path: '/', secure: cookieOptions(c, 'Lax', 0).secure });
    // Only the browser that set out may come back: another site cannot plant its own login here.
    if (!state || !nonce || !sameText(state.nonce, nonce)) return backToDashboard(c, 'state');
    const code = c.req.query('code');
    if (!code) return backToDashboard(c, 'cancelled');
    if (!(await backend.limit(c.req.raw, 'auth'))) return backToDashboard(c, 'rate-limited');
    const profile = await fetchProfile(config.login, code, callbackOf(c));
    if (!profile) return backToDashboard(c, 'discord');
    const discordId = profile.accountKey.slice('discord:'.length);
    const denied = (why: string) => {
      note(c, { kind: 'admin', accountKey: profile.accountKey, name: profile.name, detail: `${ADMIN_DENIED} ${why}` });
      return backToDashboard(c, why);
    };
    if (!(config.admin as AdminConfig).discordIds.includes(discordId)) return denied('not-allowed');
    if (!profile.mfaEnabled) return denied('mfa-required');
    await beginSession(c, discordId, profile.name);
    return backToDashboard(c);
  });
};

/** What a session may do before a passkey confirms it: see where it stands, and confirm or register one. */
export const adminPasskeyRoutes = (admin: Hono<ServerEnv>): void => {
  admin.get('/api/session', async (c) => {
    const session = sessionOf(c);
    const passkeys = await store(c).passkeysOf(session.sub);
    return c.json<AdminSessionResponse>({
      discordId: session.sub,
      name: session.name,
      stage: session.stage,
      passkeys: passkeys.length,
      mayRegister: session.stage === 'discord' && registrationRefusal(c, passkeys) === null,
      verifiedAt: session.verified * 1000,
    });
  });

  /** What the browser needs to make a passkey. */
  admin.post('/api/passkeys/options', async (c) => {
    const session = sessionOf(c);
    const passkeys = await store(c).passkeysOf(session.sub);
    const refusal = registrationRefusal(c, passkeys);
    if (refusal) return refusal;
    const { challenge, token } = challengeFor(c, 'register');
    return c.json({
      token,
      options: {
        challenge,
        rp: { id: siteOf(c).rpId, name: SITE_NAME },
        user: { id: base64url(new TextEncoder().encode(session.sub)), name: session.name, displayName: session.name },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        excludeCredentials: passkeys.map(({ id }) => ({ type: 'public-key', id })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: PASSKEY_TIMEOUT_MS,
      },
    });
  });

  /** Registers the passkey the browser made. It also confirms the session. */
  admin.post('/api/passkeys', async (c) => {
    const parsed = safeParse(registrationSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const { token, name, credential } = parsed.output;
    const session = sessionOf(c);
    const passkeys = await store(c).passkeysOf(session.sub);
    const refusal = registrationRefusal(c, passkeys);
    if (refusal) return refusal;
    const challenge = await takeChallenge(c, token, 'register');
    if (!challenge) return fail(c, 400, 'invalid-challenge');
    const result = await verifyRegistration(credential, { challenge, ...siteOf(c) });
    if (typeof result === 'string') {
      noteAdmin(c, `${ADMIN_DENIED} passkey ${result}`);
      return fail(c, 400, 'passkey-refused');
    }
    if (await store(c).passkey(credential.id)) return fail(c, 409, 'passkey-exists');
    const now = Date.now();
    const passkey: Passkey = {
      id: credential.id,
      discordId: session.sub,
      publicKey: credential.publicKey,
      algorithm: credential.algorithm as PasskeyAlgorithm,
      name: name.trim() || 'パスキー',
      createdAt: now,
      usedAt: now,
      signCount: result.signCount,
    };
    await store(c).putPasskey(passkey);
    noteAdmin(c, `register passkey ${passkey.name}`);
    confirm(c);
    return c.json({ passkey: summaryOf(passkey) }, 201);
  });

  /** What the browser needs to have one of the operator's passkeys sign. */
  admin.post('/api/passkeys/challenge', async (c) => {
    const passkeys = await store(c).passkeysOf(sessionOf(c).sub);
    if (passkeys.length === 0) return fail(c, 409, 'no-passkeys');
    const { challenge, token } = challengeFor(c, 'confirm');
    return c.json({
      token,
      options: {
        challenge,
        rpId: siteOf(c).rpId,
        allowCredentials: passkeys.map(({ id }) => ({ type: 'public-key', id })),
        userVerification: 'required',
        timeout: PASSKEY_TIMEOUT_MS,
      },
    });
  });

  /** Confirms the session with a passkey's signature (to get in, or before what cannot be undone). */
  admin.post('/api/passkeys/verify', async (c) => {
    if (!(await c.var.backend.limit(c.req.raw, 'auth'))) return fail(c, 429, 'rate-limited');
    const parsed = safeParse(assertionSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const { token, credential } = parsed.output;
    const challenge = await takeChallenge(c, token, 'confirm');
    if (!challenge) return fail(c, 400, 'invalid-challenge');
    const passkey = await store(c).passkey(credential.id);
    const result =
      passkey && passkey.discordId === sessionOf(c).sub
        ? await verifyAssertion(credential, passkey, { challenge, ...siteOf(c) })
        : 'credential';
    if (typeof result === 'string') {
      noteAdmin(c, `${ADMIN_DENIED} passkey ${result}`);
      return fail(c, 401, 'passkey-refused');
    }
    await store(c).putPasskey({ ...(passkey as Passkey), usedAt: Date.now(), signCount: result.signCount });
    confirm(c);
    return c.body(null, 204);
  });
};

/** Managing passkeys and sessions, once a passkey has confirmed it is the operator. */
export const adminSecurityRoutes = (admin: Hono<ServerEnv>): void => {
  admin.get('/api/passkeys', passkeyRequired, async (c) =>
    c.json({ passkeys: (await store(c).passkeysOf(sessionOf(c).sub)).map(summaryOf) })
  );

  /** Removes one of the operator's own passkeys. The last one stays, or nothing would let them back in. */
  admin.delete('/api/passkeys/:id', recentPasskeyRequired, async (c) => {
    const passkeys = await store(c).passkeysOf(sessionOf(c).sub);
    const passkey = passkeys.find(({ id }) => id === c.req.param('id'));
    if (!passkey) return fail(c, 404, 'not-found');
    if (passkeys.length === 1) return fail(c, 409, 'last-passkey');
    await store(c).deletePasskey(passkey.id);
    noteAdmin(c, `delete passkey ${passkey.name}`);
    return c.body(null, 204);
  });

  /** Ends every operator's session, this one too (as when a session may have been taken). */
  admin.post('/api/sessions/revoke', recentPasskeyRequired, async (c) => {
    await store(c).raiseAdminEpoch();
    noteAdmin(c, 'end every session');
    endSession(c);
    return c.body(null, 204);
  });
};
