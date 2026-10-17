import { createHmac } from 'node:crypto';

import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '../src/index';
import { issueSkywayToken, skywayConfigOf } from '../src/skyway/token';

// Issuing SkyWay tokens, for Axe delivered with SkyWay. The same paths and answers as the PHP and
// Vercel versions.

const ORIGIN = 'https://app.example';
const SKYWAY = { SKYWAY_APP_ID: 'app-id', SKYWAY_SECRET: 'skyway-secret' };

afterEach(() => vi.restoreAllMocks());

const call = (
  path: string,
  init: { method?: string; body?: string; origin?: string | null } = {},
  settings: Record<string, string> = SKYWAY
) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
  return app.fetch(
    new Request(`https://rooms.example/v1${path}`, { method: init.method ?? 'GET', headers, body: init.body }),
    { ...env, ...settings },
    createExecutionContext()
  );
};

const ask = (path: string, body: unknown, settings?: Record<string, string>) =>
  call(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, settings);

const valid = { formatVersion: 1, channelName: 'room', peerId: 'peer-1' };

const payloadOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
    iat: number;
    exp: number;
    version: number;
    scope: { app: { id: string; channels: { name: string; members: { name: string }[] }[] } };
  };

describe('the SkyWay token routes', () => {
  it('say they are up', async () => {
    const res = await call('/status');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('issue a token signed with the app secret, for the lobby and the room asked for', async () => {
    const res = await ask('/skyway/tokens', valid);

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const [header, payload, signature] = token.split('.');
    expect(signature).toBe(createHmac('sha256', 'skyway-secret').update(`${header}.${payload}`).digest('base64url'));
    const claims = payloadOf(token);
    expect(claims.version).toBe(2);
    expect(claims.exp - claims.iat).toBe(86_400);
    expect(claims.scope.app.id).toBe('app-id');
    expect(claims.scope.app.channels.map((channel) => channel.name)).toEqual(['udonarium-lobby-*-of-3', 'room']);
    expect(claims.scope.app.channels[1].members.map((member) => member.name)).toEqual(['peer-1', '*']);
  });

  it('issue one on the old path too, saying the new one replaces it', async () => {
    const res = await ask('/skyway2023/token', valid);

    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Link')).toBe('</v1/skyway/tokens>; rel="successor-version"');
  });

  it('take the lobby size and the token time from the settings', async () => {
    const res = await ask('/skyway/tokens', valid, {
      ...SKYWAY,
      SKYWAY_UDONARIUM_LOBBY_SIZE: '5',
      SKYWAY_TOKEN_TTL_SECONDS: '3600',
    });

    const claims = payloadOf(((await res.json()) as { token: string }).token);
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.scope.app.channels[0].name).toBe('udonarium-lobby-*-of-5');
  });

  // SkyWay reads "*" in a scope name as a wildcard and "\\" as its escape, so either would widen
  // the token past the room and member it was asked for.
  it.each([
    ['another format', { formatVersion: 2 }],
    ['an empty channel name', { channelName: '' }],
    ['an empty peer id', { peerId: '' }],
    ['a channel name holding a wildcard', { channelName: 'room-*' }],
    ['a channel name holding a backslash', { channelName: 'room\\1' }],
    ['a wildcard peer id', { peerId: '*' }],
    ['a lobby channel name', { channelName: 'udonarium-lobby-1-of-3' }],
    ['a channel name over 200 bytes', { channelName: 'あ'.repeat(67) }],
    ['a peer id over 200 bytes', { peerId: 'p'.repeat(201) }],
  ])('turn away %s', async (_name, change) => {
    const res = await ask('/skyway/tokens', { ...valid, ...change });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request body.' } });
  });

  it('turn away a body that is not JSON', async () => {
    const res = await ask('/skyway/tokens', '{"formatVersion": 1,');

    expect(res.status).toBe(400);
  });

  it('take names of exactly 200 bytes', async () => {
    const res = await ask('/skyway/tokens', { ...valid, channelName: 'a'.repeat(200), peerId: 'p'.repeat(200) });

    expect(res.status).toBe(200);
  });

  it('take requests only with an allowed Origin', async () => {
    const none = await call('/status', { origin: null });
    const other = await call('/status', { origin: 'https://other.example' });

    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: { code: 'ORIGIN_REQUIRED', message: 'Origin header is required.' } });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin is not allowed.' } });
  });

  it('answer the browser’s question before a token is asked for', async () => {
    const res = await call('/skyway/tokens', { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('say the settings are missing on a Worker that keeps only rooms', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const status = await call('/status', {}, {});
    const token = await ask('/skyway/tokens', valid, {});

    for (const res of [status, token]) {
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'CONFIG_INVALID', message: 'Server configuration is invalid.' },
      });
    }
    expect(error).toHaveBeenCalledWith(expect.stringContaining('set SKYWAY_APP_ID and SKYWAY_SECRET'));
  });
});

describe('the SkyWay settings', () => {
  it('fill in the lobby size and the token time when unset', () => {
    expect(skywayConfigOf(SKYWAY)).toEqual({
      appId: 'app-id',
      secret: 'skyway-secret',
      lobbySize: 3,
      tokenTtlSeconds: 86_400,
    });
  });

  it.each([
    ['no secret', { SKYWAY_APP_ID: 'app-id' }],
    ['a token time under a minute', { ...SKYWAY, SKYWAY_TOKEN_TTL_SECONDS: '59' }],
    ['a token time over a week', { ...SKYWAY, SKYWAY_TOKEN_TTL_SECONDS: '604801' }],
    ['no lobby', { ...SKYWAY, SKYWAY_UDONARIUM_LOBBY_SIZE: '0' }],
  ])('are wrong with %s', (_name, settings) => {
    expect(skywayConfigOf(settings)).toHaveProperty('problem');
  });
});

describe('issueSkywayToken', () => {
  it('stamps the token with the time and id given', () => {
    const config = { appId: 'app-id', secret: 'skyway-secret', lobbySize: 3, tokenTtlSeconds: 60 };

    const claims = payloadOf(issueSkywayToken(config, { channelName: 'room', peerId: 'peer-1' }, 1000, 'jti-1'));

    expect(claims).toMatchObject({ jti: 'jti-1', iat: 1000, exp: 1060 });
  });
});
