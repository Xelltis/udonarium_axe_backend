import { Hono } from 'hono';
import type { Context } from 'hono';
import { literal, object, regex, pipe, safeParse, string, variant } from 'valibot';

import type { AuthConfigResponse, TokenResponse } from '../../contracts/protocol';
import type { LoginConfig } from '../config';
import type { AppEnv } from '../http/context';
import { fail } from '../http/errors';
import { networkOfRequest, withinLimits } from '../http/limits';
import { isAllowedOrigin, tryParseUrl } from '../http/origin';
import { authorizeUrl, fetchProfile } from './discord';
import { accountOf, bearerOf, packSecret, tokensOf, unpackSecret } from './session';
import { LOGIN_STATE_SECONDS, readToken, signToken } from './tokens';

/** PKCE の code_challenge（SHA-256 の base64url。43文字） */
const CHALLENGE = /^[\w-]{43}$/;

/** PKCE の code_verifier（RFC 7636 の決まりの文字と長さ） */
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

const callbackUrl = (c: Context<AppEnv>): string =>
  `${new URL(c.req.url).origin}/v1/login/discord/callback`;

/**
 * ログインのあとに戻ってよい場所。許可した Origin のページだけで、`*` は数えない。
 * どこにでも戻せると、ほかのサイトがログインのコードを受け取れてしまうため
 */
const isLoginRedirect = (redirect: string, allowedOrigins: string[]): boolean => {
  const url = tryParseUrl(redirect);
  return (
    url !== null &&
    isAllowedOrigin(
      url.origin,
      allowedOrigins.filter((origin) => origin !== '*'),
    )
  );
};

type LoginHandler = (c: Context<AppEnv>, login: LoginConfig) => Response | Promise<Response>;

/** ログインを置いていない Worker では 503 で断る */
const withLogin =
  (handler: LoginHandler) =>
  (c: Context<AppEnv>): Response | Promise<Response> => {
    const login = c.var.config.login;
    return login ? handler(c, login) : fail(c, 503, 'login-unavailable');
  };

/** ブラウザがページとして開くもの。CORS は要らない */
export const loginRoutes = new Hono<AppEnv>();

/**
 * ログインを始める。Axe は code_verifier を作って手元に置き、その SHA-256（code_challenge）と、
 * 戻ってくる URL を渡してここを開く。戻ってきたら、コードと code_verifier をトークンに替える
 */
loginRoutes.get(
  '/discord',
  withLogin((c, login) => {
    const redirect = c.req.query('redirect_uri') ?? '';
    const challenge = c.req.query('code_challenge') ?? '';
    if (!isLoginRedirect(redirect, c.var.config.allowedOrigins) || !CHALLENGE.test(challenge)) {
      return fail(c, 400, 'invalid-request');
    }
    const state = signToken<'login'>(
      { aud: 'login', redirect, challenge },
      LOGIN_STATE_SECONDS,
      login.sessionSecret,
    );
    return c.redirect(authorizeUrl(login, callbackUrl(c), state), 302);
  }),
);

/** Discord から戻ってくる。Axe の戻り先へ、フラグメントにコードか失敗の理由を付けて返す */
loginRoutes.get(
  '/discord/callback',
  withLogin(async (c, login) => {
    const state = readToken(c.req.query('state') ?? '', 'login', login.sessionSecret);
    if (!state) return fail(c, 400, 'invalid-request');
    const back = (fragment: Record<string, string>) => {
      const url = new URL(state.redirect);
      url.hash = new URLSearchParams(fragment).toString();
      return c.redirect(url.toString(), 302);
    };

    const code = c.req.query('code');
    if (!code) return back({ login_error: 'denied' });
    if (!(await withinLimits(c, c.env.AUTH_LIMITER, [networkOfRequest(c)]))) {
      return back({ login_error: 'rate-limited' });
    }
    const profile = await fetchProfile(login, code, callbackUrl(c));
    if (!profile) return back({ login_error: 'provider-failed' });
    const secret = await accountOf(c.env, profile.accountKey).signIn(profile, state.challenge);
    return back({ login_code: packSecret(profile.accountKey, secret) });
  }),
);

/** Axe から呼ぶもの。許可した Origin からだけ受ける */
export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/config', (c) =>
  c.json<AuthConfigResponse>({ providers: c.var.config.login ? ['discord'] : [] }),
);

authRoutes.post(
  '/token',
  withLogin(async (c, login) => {
    if (!(await withinLimits(c, c.env.AUTH_LIMITER, [networkOfRequest(c)]))) {
      return fail(c, 429, 'rate-limited');
    }
    const parsed = safeParse(tokenRequestSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const request = parsed.output;
    const handle = unpackSecret(
      request.grant_type === 'login_code' ? request.code : request.refresh_token,
    );
    if (!handle) return fail(c, 400, 'invalid-grant');
    const account = accountOf(c.env, handle.accountKey);
    const session =
      request.grant_type === 'login_code'
        ? await account.redeem(handle.secret, request.code_verifier)
        : await account.refresh(handle.secret);
    if (!session) return fail(c, 400, 'invalid-grant');
    return c.json<TokenResponse>(tokensOf(session, login));
  }),
);

authRoutes.post(
  '/logout',
  withLogin(async (c) => {
    const parsed = safeParse(logoutSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const handle = unpackSecret(parsed.output.refresh_token);
    if (handle) await accountOf(c.env, handle.accountKey).signOut(handle.secret);
    return c.body(null, 204);
  }),
);

/** ログインしている人のアカウント。Authorization: Bearer のアクセストークンで尋ねる */
export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get(
  '/',
  withLogin(async (c, login) => {
    const claims = bearerOf(c, login);
    if (!claims) return fail(c, 401, 'login-required');
    const account = await accountOf(c.env, claims.sub).account();
    return account ? c.json(account) : fail(c, 404, 'not-found');
  }),
);

/** アカウントを消す。人の情報とトークンが消え、そのアクセストークンが切れたあとはもうログインしていない */
accountRoutes.delete(
  '/',
  withLogin(async (c, login) => {
    const claims = bearerOf(c, login);
    if (!claims) return fail(c, 401, 'login-required');
    await accountOf(c.env, claims.sub).erase();
    return c.body(null, 204);
  }),
);
