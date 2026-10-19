import { Hono } from 'hono';
import type { Context } from 'hono';
import { literal, object, regex, pipe, safeParse, string, variant } from 'valibot';

import type { AuthConfigResponse, TokenResponse } from '../../../../contracts/protocol.js';
import { authorizeUrl, fetchProfile } from '../../auth/discord.js';
import { packSecret, tokensOf, unpackSecret } from '../../auth/session.js';
import { LOGIN_STATE_SECONDS, readToken, signToken } from '../../auth/tokens.js';
import type { LoginConfig } from '../../config/login.js';
import type { ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { accountBanOf, addressBanOf, note, pausedNow } from '../moderation.js';
import { isAllowedOrigin, tryParseUrl } from '../origin.js';
import { bearerOf } from '../request.js';

/** The PKCE code_challenge (the SHA-256 in base64url, 43 characters). */
const CHALLENGE = /^[\w-]{43}$/;

/** The PKCE code_verifier (the characters and length set by RFC 7636). */
const VERIFIER = /^[\w.~-]{43,128}$/;

const tokenRequestSchema = variant('grant_type', [
  object({
    grant_type: literal('login_code'),
    code: string(),
    code_verifier: pipe(string(), regex(VERIFIER)),
  }),
  object({ grant_type: literal('refresh_token'), refresh_token: string() }),
]);

const logoutSchema = object({ refresh_token: string() });

const callbackUrl = (c: Context<ServerEnv>): string => `${new URL(c.req.url).origin}/v1/login/discord/callback`;

/** Sends the browser back to Axe's return address, with the code or the reason it failed in the fragment. */
const backTo = (c: Context<ServerEnv>, redirect: string, fragment: Record<string, string>) => {
  const url = new URL(redirect);
  url.hash = new URLSearchParams(fragment).toString();
  return c.redirect(url.toString(), 302);
};

/**
 * Where a login may return to: only pages on allowed Origins, and `*` does not count.
 * If it could return anywhere, another site could receive the login code.
 */
const isLoginRedirect = (redirect: string, allowedOrigins: string[]): boolean => {
  const url = tryParseUrl(redirect);
  return (
    url !== null &&
    isAllowedOrigin(
      url.origin,
      allowedOrigins.filter((origin) => origin !== '*')
    )
  );
};

type LoginHandler = (c: Context<ServerEnv>, login: LoginConfig) => Response | Promise<Response>;

/** Refuses with 503 on a room server with no login set up. */
const withLogin =
  (handler: LoginHandler) =>
  (c: Context<ServerEnv>): Response | Promise<Response> => {
    const login = c.var.config.login;
    return login ? handler(c, login) : fail(c, 503, 'login-unavailable');
  };

/** What a browser opens as a page. It needs no CORS. */
export const loginRoutes = new Hono<ServerEnv>();

/**
 * Starts a login. Axe makes a code_verifier and keeps it to itself, then opens this with its
 * SHA-256 (code_challenge) and the URL to come back to. Once back, it exchanges the code and the
 * code_verifier for tokens.
 */
loginRoutes.get(
  '/discord',
  withLogin(async (c, login) => {
    const redirect = c.req.query('redirect_uri') ?? '';
    const challenge = c.req.query('code_challenge') ?? '';
    if (!isLoginRedirect(redirect, c.var.config.allowedOrigins) || !CHALLENGE.test(challenge)) {
      return fail(c, 400, 'invalid-request');
    }
    if (await addressBanOf(c)) return backTo(c, redirect, { login_error: 'banned' });
    const state = signToken<'login'>({ aud: 'login', redirect, challenge }, LOGIN_STATE_SECONDS, login.sessionSecret);
    return c.redirect(authorizeUrl(login, callbackUrl(c), state), 302);
  })
);

/**
 * Comes back from Discord. Sends the browser back to Axe's return address, with the code or the
 * reason it failed in the fragment.
 */
loginRoutes.get(
  '/discord/callback',
  withLogin(async (c, login) => {
    const state = readToken(c.req.query('state') ?? '', 'login', login.sessionSecret);
    if (!state) return fail(c, 400, 'invalid-request');
    const back = (fragment: Record<string, string>) => backTo(c, state.redirect, fragment);

    const code = c.req.query('code');
    if (!code) return back({ login_error: 'denied' });
    if (await addressBanOf(c)) return back({ login_error: 'banned' });
    if (!(await c.var.backend.limit(c.req.raw, 'auth'))) return back({ login_error: 'rate-limited' });
    const profile = await fetchProfile(login, code, callbackUrl(c));
    if (!profile) return back({ login_error: 'provider-failed' });
    // A banned sender or account is told so, and nothing about it is kept or brought up to date. It
    // goes by the bans as they stand, read only for a login Discord vouched for.
    if ((await addressBanOf(c, true)) ?? (await accountBanOf(c, profile.accountKey, true))) {
      return back({ login_error: 'banned' });
    }
    // The operator may have stopped new logins for now. Those logged in already go on.
    if (await pausedNow(c, 'logins')) return back({ login_error: 'paused' });
    const secret = await c.var.backend.account(profile.accountKey).signIn(profile, state.challenge);
    note(c, { kind: 'login', accountKey: profile.accountKey, name: profile.name });
    return back({ login_code: packSecret(profile.accountKey, secret) });
  })
);

/** What Axe calls. Taken only from allowed Origins. */
export const authRoutes = new Hono<ServerEnv>();

authRoutes.get('/config', (c) => c.json<AuthConfigResponse>({ providers: c.var.config.login ? ['discord'] : [] }));

authRoutes.post(
  '/token',
  withLogin(async (c, login) => {
    if (!(await c.var.backend.limit(c.req.raw, 'auth'))) return fail(c, 429, 'rate-limited');
    const parsed = safeParse(tokenRequestSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const request = parsed.output;
    const handle = unpackSecret(request.grant_type === 'login_code' ? request.code : request.refresh_token);
    if (!handle) return fail(c, 400, 'invalid-grant');
    // A banned account gets no new tokens. Answered as a grant no longer good, Axe logs it out. The
    // bans this instance holds turn it away before the account is asked; the bans as they stand are
    // read only once the account has found the grant good, so that made-up grants read nothing.
    if (await accountBanOf(c, handle.accountKey)) return fail(c, 400, 'invalid-grant');
    const account = c.var.backend.account(handle.accountKey);
    const session =
      request.grant_type === 'login_code'
        ? await account.redeem(handle.secret, request.code_verifier)
        : await account.refresh(handle.secret);
    if (!session) return fail(c, 400, 'invalid-grant');
    if (await addressBanOf(c, true)) return fail(c, 403, 'banned');
    if (await accountBanOf(c, handle.accountKey, true)) return fail(c, 400, 'invalid-grant');
    return c.json<TokenResponse>(tokensOf(session, login));
  })
);

authRoutes.post(
  '/logout',
  withLogin(async (c) => {
    // An account is looked up from the key, so, as for tokens, each sender may do this only so many
    // times. Otherwise made-up keys could wake up any number of account stores.
    if (!(await c.var.backend.limit(c.req.raw, 'auth'))) return fail(c, 429, 'rate-limited');
    const parsed = safeParse(logoutSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const handle = unpackSecret(parsed.output.refresh_token);
    if (handle) await c.var.backend.account(handle.accountKey).signOut(handle.secret);
    return c.body(null, 204);
  })
);

/** The account of whoever is logged in. Asked for with the access token in Authorization: Bearer. */
export const accountRoutes = new Hono<ServerEnv>();

accountRoutes.get(
  '/',
  withLogin(async (c, login) => {
    const claims = bearerOf(c, login);
    if (!claims) return fail(c, 401, 'login-required');
    // An account the same person made again after deleting one is not shown for a token of the
    // old account.
    const account = await c.var.backend.account(claims.sub).account();
    return account?.userId === claims.uid ? c.json(account) : fail(c, 404, 'not-found');
  })
);

/**
 * Deletes the account. The person's details and tokens are deleted, and once that access token
 * runs out the person is no longer logged in.
 */
accountRoutes.delete(
  '/',
  withLogin(async (c, login) => {
    const claims = bearerOf(c, login);
    if (!claims) return fail(c, 401, 'login-required');
    // A token of the old account cannot delete the account made again.
    if (!(await c.var.backend.account(claims.sub).erase(claims.uid))) return fail(c, 404, 'not-found');
    return c.body(null, 204);
  })
);
