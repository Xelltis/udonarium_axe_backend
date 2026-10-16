import { vi } from 'vitest';

import type { TokenResponse } from '../../contracts/protocol.js';
import { base64url } from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';
import { ORIGIN, freshIp } from './helpers.js';

export const BACKEND = 'https://backend.example';
export const APP = `${ORIGIN}/`;
export const VERIFIER = 'verifier-for-tests-0123456789-abcdefghijklmnopq';

export const challengeOf = async (verifier: string) =>
  base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );

/** Discord の API の答え。数なら、その状態で失敗する */
type Answer = object | number;

const answer = (value: Answer) =>
  typeof value === 'number' ? new Response('failed', { status: value }) : Response.json(value);

/**
 * Discord の API の代わりに答える。答えは呼ばれるたびに作る
 * （テストで作った Response は、Worker のリクエストの中では読めない）
 */
export const fakeDiscord = (
  user: Answer = { id: '42', username: 'kai', global_name: 'Kai', avatar: 'face' },
  token: Answer = { access_token: 'discord-token', token_type: 'Bearer' },
) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://discord.com/api/oauth2/token') return answer(token);
    if (url === 'https://discord.com/api/v10/users/@me') return answer(user);
    throw new Error(`unexpected fetch: ${url}`);
  });

/** ブラウザがページとして開く。Origin は付かない */
export const navigate = (path: string, ip = freshIp()) =>
  harness.fetch(
    new Request(`${BACKEND}${path}`, { headers: { 'CF-Connecting-IP': ip }, redirect: 'manual' }),
  );

/** Axe から API を呼ぶ */
export const callApi = (
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
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
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
    }),
  );

/** ログインを始めて、Discord の同意の画面から戻ってくるまで。戻り先の URL を返す */
export const signInWithDiscord = async (verifier = VERIFIER, redirect = APP) => {
  const start = await navigate(
    `/v1/login/discord?redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${await challengeOf(verifier)}`,
  );
  const state = new URL(start.headers.get('Location') as string).searchParams.get('state');
  const back = await navigate(`/v1/login/discord/callback?code=discord-code&state=${state}`);
  return new URL(back.headers.get('Location') as string);
};

/** ログインして、トークンの組まで受け取る */
export const logIn = async (user?: Answer) => {
  const discord = fakeDiscord(user);
  const back = await signInWithDiscord();
  discord.mockRestore();
  const code = new URLSearchParams(back.hash.slice(1)).get('login_code');
  const res = await callApi('/v1/auth/token', {
    method: 'POST',
    body: { grant_type: 'login_code', code, code_verifier: VERIFIER },
  });
  return res.json<TokenResponse>();
};
