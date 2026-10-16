import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_USER_ID_PREFIX } from '../../contracts/protocol.js';
import type { TokenResponse } from '../../contracts/protocol.js';
import { unpackSecret } from '../../src/core/auth/session.js';
import { base64url, readToken } from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';
import {
  APP,
  BACKEND,
  VERIFIER,
  callApi,
  challengeOf,
  fakeDiscord,
  logIn,
  navigate,
  signInWithDiscord,
} from './auth-helpers.js';
import { ORIGIN, SESSION_SECRET, accessTokenFor, freshIp, jsonOf } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** ログインの3つを外した Worker に送る */
const withoutLogin = (request: Request) =>
  harness.fetchWith(request, {
    DISCORD_CLIENT_ID: undefined,
    DISCORD_CLIENT_SECRET: undefined,
    SESSION_SECRET: undefined,
  });

const fragmentOf = (url: URL) => new URLSearchParams(url.hash.slice(1));

const exchange = (code: string | null, verifier = VERIFIER) =>
  callApi('/v1/auth/token', {
    method: 'POST',
    body: { grant_type: 'login_code', code, code_verifier: verifier },
  });

const refresh = (refreshToken: string) =>
  callApi('/v1/auth/token', {
    method: 'POST',
    body: { grant_type: 'refresh_token', refresh_token: refreshToken },
  });

const accountKeyOf = (tokens: TokenResponse) =>
  unpackSecret(tokens.refreshToken)?.accountKey as string;

describe('GET /v1/auth/config', () => {
  it('names Discord while login is set up, and nothing otherwise', async () => {
    const on = await callApi('/v1/auth/config');
    const off = await withoutLogin(
      new Request(`${BACKEND}/v1/auth/config`, { headers: { Origin: ORIGIN } }),
    );

    expect(await on.json()).toEqual({ providers: ['discord'] });
    expect(on.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await off.json()).toEqual({ providers: [] });
  });
});

describe('GET /v1/login/discord', () => {
  it('sends the browser to Discord asking only who the user is', async () => {
    const res = await navigate(
      `/v1/login/discord?redirect_uri=${encodeURIComponent(APP)}&code_challenge=${await challengeOf(VERIFIER)}`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location') as string);
    expect(`${location.origin}${location.pathname}`).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'test-client',
      scope: 'identify',
      redirect_uri: `${BACKEND}/v1/login/discord/callback`,
      state: expect.any(String),
    });
    const state = readToken(location.searchParams.get('state') as string, 'login', SESSION_SECRET);
    expect(state?.redirect).toBe(APP);
  });

  it.each([
    ['a page that is not listed', 'https://elsewhere.example/', 'c'.repeat(43)],
    ['something that is not a URL', 'not a url', 'c'.repeat(43)],
    ['a challenge of the wrong shape', APP, 'short'],
  ])('turns away %s', async (_name, redirect, challenge) => {
    const res = await navigate(
      `/v1/login/discord?redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-request' });
  });

  it('turns away a start without the redirect or the challenge', async () => {
    expect((await navigate('/v1/login/discord')).status).toBe(400);
  });

  it('does not count `*` as a page it may send the code to', async () => {
    const res = await harness.fetchWith(
      new Request(
        `${BACKEND}/v1/login/discord?redirect_uri=${encodeURIComponent(APP)}&code_challenge=${'c'.repeat(43)}`,
      ),
      { ACCESS_CONTROL_ALLOW_ORIGIN: '*' },
    );
    expect(res.status).toBe(400);
  });

  it('answers 503 while login is not set up', async () => {
    const res = await withoutLogin(new Request(`${BACKEND}/v1/login/discord`));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'login-unavailable' });
  });
});

describe('GET /v1/login/discord/callback', () => {
  it('returns to the app with a one-time code, keeping nothing from Discord but who it is', async () => {
    const discord = fakeDiscord();

    const back = await signInWithDiscord();

    expect(`${back.origin}${back.pathname}`).toBe(APP);
    expect(fragmentOf(back).get('login_code')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    const [tokenCall, userCall] = discord.mock.calls;
    const tokenRequest = new Request(tokenCall[0] as string, tokenCall[1]);
    expect(tokenRequest.headers.get('Authorization')).toBe(
      `Basic ${btoa('test-client:test-client-secret')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(await tokenRequest.text()))).toEqual({
      grant_type: 'authorization_code',
      code: 'discord-code',
      redirect_uri: `${BACKEND}/v1/login/discord/callback`,
    });
    expect(new Headers(userCall[1]?.headers).get('Authorization')).toBe('Bearer discord-token');
  });

  it.each([
    ['the token request fails', [undefined, 401]],
    ['the token answer has no token', [undefined, { token_type: 'Bearer' }]],
    ['the user request fails', [500]],
    ['the user answer has no id', [{ username: 'kai' }]],
  ] as const)('returns with provider-failed when %s', async (_name, args) => {
    fakeDiscord(...(args as unknown as Parameters<typeof fakeDiscord>));

    const back = await signInWithDiscord();

    expect(fragmentOf(back).get('login_error')).toBe('provider-failed');
  });

  it('returns with denied when the user said no on Discord', async () => {
    const start = await navigate(
      `/v1/login/discord?redirect_uri=${encodeURIComponent(APP)}&code_challenge=${await challengeOf(VERIFIER)}`,
    );
    const state = new URL(start.headers.get('Location') as string).searchParams.get('state');

    const back = await navigate(`/v1/login/discord/callback?error=access_denied&state=${state}`);

    expect(fragmentOf(new URL(back.headers.get('Location') as string)).get('login_error')).toBe(
      'denied',
    );
  });

  it('turns away a state it did not sign, or none at all', async () => {
    expect((await navigate('/v1/login/discord/callback?code=c&state=forged')).status).toBe(400);
    expect((await navigate('/v1/login/discord/callback?code=c')).status).toBe(400);
  });

  it('stops one address once it has come back too often', async () => {
    fakeDiscord();
    const start = await navigate(
      `/v1/login/discord?redirect_uri=${encodeURIComponent(APP)}&code_challenge=${await challengeOf(VERIFIER)}`,
    );
    const state = new URL(start.headers.get('Location') as string).searchParams.get('state');
    const ip = freshIp();

    const errors: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const back = await navigate(`/v1/login/discord/callback?code=c&state=${state}`, ip);
      errors.push(fragmentOf(new URL(back.headers.get('Location') as string)).get('login_error'));
    }

    expect(errors).toEqual([null, null, null, null, null, 'rate-limited']);
  });
});

describe('POST /v1/auth/token', () => {
  it('turns the code into tokens that name the same user every time', async () => {
    const first = await logIn({ id: '7', username: 'rin', global_name: null, avatar: null });
    const second = await logIn({ id: '7', username: 'rin', global_name: 'Rin', avatar: 'a1' });

    expect(first.account).toEqual({
      userId: expect.stringMatching(new RegExp(`^${ACCOUNT_USER_ID_PREFIX}[0-9a-f-]{36}$`)),
      name: 'rin',
      avatarUrl: null,
    });
    expect(second.account).toEqual({
      userId: first.account.userId,
      name: 'Rin',
      avatarUrl: 'https://cdn.discordapp.com/avatars/7/a1.png',
    });
    expect(first.expiresIn).toBe(15 * 60);
    expect(readToken(first.accessToken, 'access', SESSION_SECRET)).toEqual({
      aud: 'access',
      sub: 'discord:7',
      uid: first.account.userId,
      name: 'rin',
      exp: expect.any(Number),
    });
  });

  it('takes a code once, and only with the verifier it was made for', async () => {
    fakeDiscord();
    const wrong = fragmentOf(await signInWithDiscord()).get('login_code');
    const right = fragmentOf(await signInWithDiscord()).get('login_code');

    const withWrongVerifier = await exchange(wrong, `${VERIFIER}x`);
    const afterwards = await exchange(wrong);
    const once = await exchange(right);
    const twice = await exchange(right);

    expect([withWrongVerifier.status, afterwards.status, once.status, twice.status]).toEqual([
      400, 400, 200, 400,
    ]);
    expect(await twice.json()).toEqual({ error: 'invalid-grant' });
  });

  it('turns away a code that has run out, or whose secret is wrong', async () => {
    fakeDiscord({ id: '8', username: 'ran' });
    const old = fragmentOf(await signInWithDiscord()).get('login_code') as string;
    const tampered = fragmentOf(await signInWithDiscord()).get('login_code') as string;
    await harness.expireLoginCode('discord:8', old.split('.')[1]);

    const expired = await exchange(old);
    const forged = await exchange(`${tampered.slice(0, -2)}xx`);
    const unknown = await exchange(`${tampered.split('.')[0]}.nope.nope`);
    const malformed = await exchange('not-a-code');

    for (const res of [expired, forged, unknown, malformed]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid-grant' });
    }
  });

  it('swaps a refresh token for a new pair, and drops the whole line when an old one comes back', async () => {
    const tokens = await logIn({ id: '9', username: 'sei' });

    const swapped = await refresh(tokens.refreshToken);
    const next = await jsonOf<TokenResponse>(swapped);
    const replayed = await refresh(tokens.refreshToken);
    const afterTheft = await refresh(next.refreshToken);

    expect(swapped.status).toBe(200);
    expect(next.account).toEqual(tokens.account);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(replayed.status).toBe(400);
    expect(afterTheft.status).toBe(400);
  });

  it('takes a refresh token sent twice at once only once, and drops the whole line', async () => {
    const tokens = await logIn({ id: '15', username: 'kei' });

    const answers = await Promise.all([refresh(tokens.refreshToken), refresh(tokens.refreshToken)]);
    const statuses = answers.map((res) => res.status).sort();
    const winner = answers.find((res) => res.status === 200) as Response;
    const next = await jsonOf<TokenResponse>(winner);

    expect(statuses).toEqual([200, 400]);
    expect((await refresh(next.refreshToken)).status).toBe(400);
  });

  it('drops the whole line even when hashing lets the second refresh in between', async () => {
    const tokens = await logIn({ id: '16', username: 'ren' });
    // 計算のたびにほかのリクエストへ順番を譲る。workerd の digest が譲らなくても、すき間を作る
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return digest(algorithm, data);
    });

    const answers = await Promise.all([refresh(tokens.refreshToken), refresh(tokens.refreshToken)]);
    vi.restoreAllMocks();
    const winner = answers.find((res) => res.status === 200);

    expect(answers.map((res) => res.status).sort()).toEqual([200, 400]);
    const next = await jsonOf<TokenResponse>(winner as Response);
    expect((await refresh(next.refreshToken)).status).toBe(400);
  });

  it('turns away a refresh token whose secret is wrong', async () => {
    const tokens = await logIn({ id: '14', username: 'nao' });
    expect((await refresh(`${tokens.refreshToken.slice(0, -2)}xx`)).status).toBe(400);
    expect((await refresh(tokens.refreshToken)).status).toBe(200);
  });

  it('turns away a refresh token that has run out', async () => {
    const tokens = await logIn({ id: '10', username: 'tou' });
    await harness.expireRefreshTokens(accountKeyOf(tokens));

    expect((await refresh(tokens.refreshToken)).status).toBe(400);
  });

  it.each([
    ['a body that is not JSON', 'grant_type=login_code'],
    ['an unknown grant', { grant_type: 'password' }],
    [
      'a verifier of the wrong shape',
      { grant_type: 'login_code', code: 'a.b.c', code_verifier: 'x' },
    ],
  ])('turns away %s', async (_name, body) => {
    const res = await callApi('/v1/auth/token', { method: 'POST', body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-request' });
  });

  it('stops one address once it has asked too often', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await callApi('/v1/auth/token', {
        method: 'POST',
        body: { grant_type: 'refresh_token', refresh_token: 'a.b.c' },
        headers: { 'CF-Connecting-IP': ip },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it('answers 503 while login is not set up', async () => {
    const res = await withoutLogin(
      new Request(`${BACKEND}/v1/auth/token`, { method: 'POST', headers: { Origin: ORIGIN } }),
    );
    expect(res.status).toBe(503);
  });

  it('turns away a page that is not listed', async () => {
    const res = await callApi('/v1/auth/token', {
      method: 'POST',
      body: {},
      headers: { Origin: 'https://elsewhere.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/auth/logout', () => {
  it('drops the line of refresh tokens', async () => {
    const tokens = await logIn({ id: '11', username: 'yuu' });

    const res = await callApi('/v1/auth/logout', {
      method: 'POST',
      body: { refresh_token: tokens.refreshToken },
    });

    expect(res.status).toBe(204);
    expect((await refresh(tokens.refreshToken)).status).toBe(400);
  });

  it('answers 204 for a token it does not know, and 400 for a body it cannot read', async () => {
    const unknown = await callApi('/v1/auth/logout', {
      method: 'POST',
      body: { refresh_token: 'whatever' },
    });
    const unreadable = await callApi('/v1/auth/logout', { method: 'POST', body: 'nope' });
    const stranger = await callApi('/v1/auth/logout', {
      method: 'POST',
      body: { refresh_token: `${base64url(new TextEncoder().encode('discord:404'))}.a.b` },
    });

    expect([unknown.status, unreadable.status, stranger.status]).toEqual([204, 400, 204]);
  });

  it('stops one address once it has asked too often, since each key wakes an account', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await callApi('/v1/auth/logout', {
        method: 'POST',
        body: { refresh_token: 'whatever' },
        headers: { 'CF-Connecting-IP': ip },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
  });
});

describe('/v1/account', () => {
  it('tells who is logged in', async () => {
    const tokens = await logIn({ id: '12', username: 'aoi' });

    const res = await callApi('/v1/account', { token: tokens.accessToken });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(tokens.account);
  });

  it('deletes the account and every token with it', async () => {
    const tokens = await logIn({ id: '13', username: 'mei' });

    const deleted = await callApi('/v1/account', { method: 'DELETE', token: tokens.accessToken });
    const after = await callApi('/v1/account', { token: tokens.accessToken });

    expect(deleted.status).toBe(204);
    expect(after.status).toBe(404);
    expect((await refresh(tokens.refreshToken)).status).toBe(400);
  });

  it('neither shows nor deletes an account made again, for a token of the one deleted', async () => {
    const before = await logIn({ id: '16', username: 'rin' });
    await callApi('/v1/account', { method: 'DELETE', token: before.accessToken });
    const again = await logIn({ id: '16', username: 'rin' });

    const seen = await callApi('/v1/account', { token: before.accessToken });
    const removal = await callApi('/v1/account', { method: 'DELETE', token: before.accessToken });

    expect(again.account.userId).not.toBe(before.account.userId);
    expect(seen.status).toBe(404);
    expect(removal.status).toBe(404);
    expect((await callApi('/v1/account', { token: again.accessToken })).status).toBe(200);
  });

  it('asks for login without a token, or with one that has run out', async () => {
    const none = await callApi('/v1/account');
    const expired = await callApi('/v1/account', { token: accessTokenFor('someone', -1) });
    const removal = await callApi('/v1/account', { method: 'DELETE' });

    for (const res of [none, expired, removal]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'login-required' });
    }
  });

  it('answers 503 while login is not set up', async () => {
    const res = await withoutLogin(
      new Request(`${BACKEND}/v1/account`, { headers: { Origin: ORIGIN } }),
    );
    expect(res.status).toBe(503);
  });

  it('lets a page send the token in a preflight', async () => {
    const res = await callApi('/v1/account', {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type,Authorization,X-Asset-Name',
    );
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET,HEAD,POST,PUT,DELETE');
  });
});
