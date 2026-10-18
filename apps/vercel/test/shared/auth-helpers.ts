import { vi } from 'vitest';

import type { TokenResponse } from '../../contracts/protocol.js';
import { base64url } from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';
import { ORIGIN, freshIp, jsonOf } from './helpers.js';

export const BACKEND = 'https://backend.example';
export const APP = `${ORIGIN}/`;
export const VERIFIER = 'verifier-for-tests-0123456789-abcdefghijklmnopq';

export const challengeOf = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

/** An answer from the Discord API. A number fails with that status. */
type Answer = object | number;

const answer = (value: Answer) =>
  typeof value === 'number' ? new Response('failed', { status: value }) : Response.json(value);

/**
 * Answers in place of the Discord API. The answer is made each time it is called
 * (a Response made in a test cannot be read inside the Worker's request).
 */
export const fakeDiscord = (
  user: Answer = { id: '42', username: 'kai', global_name: 'Kai', avatar: 'face' },
  token: Answer = { access_token: 'discord-token', token_type: 'Bearer' }
) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://discord.com/api/oauth2/token') return answer(token);
    if (url === 'https://discord.com/api/v10/users/@me') return answer(user);
    throw new Error(`unexpected fetch: ${url}`);
  });

/** Opens it as a page, as the browser does. No Origin is sent. */
export const navigate = (path: string, ip = freshIp()) =>
  harness.fetch(new Request(`${BACKEND}${path}`, { headers: { 'CF-Connecting-IP': ip }, redirect: 'manual' }));

/** Calls the API as Axe does. */
export const callApi = (
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}
) =>
  harness.fetch(
    new Request(`${BACKEND}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Origin: ORIGIN,
        'CF-Connecting-IP': freshIp(),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    })
  );

/** Starts a login and goes as far as coming back from Discord's consent screen. Returns the URL it comes back to. */
export const signInWithDiscord = async (verifier = VERIFIER, redirect = APP) => {
  const start = await navigate(
    `/v1/login/discord?redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${await challengeOf(verifier)}`
  );
  const state = new URL(start.headers.get('Location') as string).searchParams.get('state');
  const back = await navigate(`/v1/login/discord/callback?code=discord-code&state=${state}`);
  return new URL(back.headers.get('Location') as string);
};

/** Logs in, through to getting the pair of tokens. */
export const logIn = async (user?: Answer) => {
  const discord = fakeDiscord(user);
  const back = await signInWithDiscord();
  discord.mockRestore();
  const code = new URLSearchParams(back.hash.slice(1)).get('login_code');
  const res = await callApi('/v1/auth/token', {
    method: 'POST',
    body: { grant_type: 'login_code', code, code_verifier: VERIFIER },
  });
  return jsonOf<TokenResponse>(res);
};
