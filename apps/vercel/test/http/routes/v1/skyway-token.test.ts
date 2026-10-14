import { Hono } from 'hono';

import { skywayTokenRoute } from '../../../../src/http/routes/v1/skyway-token.js';
import { onError } from '../../../../src/http/errors/handler.js';
import type { AppConfig } from '../../../../src/config/types.js';
import type { AppEnv } from '../../../../src/http/context.js';

const stubConfig = (): AppConfig => ({
  skyway: { appId: 'app', secret: 'secret', lobbySize: 3, tokenTtlSeconds: 86_400 },
  cors: { allowedOrigins: ['*'] },
  environment: undefined,
});

const buildApp = () => {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('*', async (c, next) => {
    c.set('config', stubConfig());
    await next();
  });
  app.route('/', skywayTokenRoute);
  return app;
};

const validBody = JSON.stringify({ formatVersion: 1, channelName: 'room', peerId: 'peer-1' });

const post = (path: string, body: string = validBody) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

describe('skywayTokenRoute', () => {
  it('POST /skyway/tokens returns a JWT', async () => {
    const res = await buildApp().fetch(post('/skyway/tokens'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('POST /skyway2023/token (legacy) returns a JWT plus deprecation headers', async () => {
    const res = await buildApp().fetch(post('/skyway2023/token'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Link')).toBe('</v1/skyway/tokens>; rel="successor-version"');
    const body = (await res.json()) as { token: string };
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('returns 400 with VALIDATION_FAILED on bad body', async () => {
    const res = await buildApp().fetch(
      post('/skyway/tokens', JSON.stringify({ formatVersion: 2 })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid request body.' },
    });
  });

  it('returns 400 with VALIDATION_FAILED on bad body for legacy path too', async () => {
    const res = await buildApp().fetch(
      post('/skyway2023/token', JSON.stringify({ formatVersion: 2 })),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 with VALIDATION_FAILED on a body that is not JSON', async () => {
    const res = await buildApp().fetch(post('/skyway/tokens', '{"formatVersion": 1,'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid request body.' },
    });
  });

  // SkyWay reads "*" in a scope name as a wildcard and "\\" as its escape, so either would widen
  // the token past the room and member it was asked for.
  it.each([
    ['an empty channel name', { channelName: '' }],
    ['an empty peer id', { peerId: '' }],
    ['a wildcard channel name', { channelName: '*' }],
    ['a channel name holding a wildcard', { channelName: 'room-*' }],
    ['a channel name holding a backslash', { channelName: 'room\\1' }],
    ['a wildcard peer id', { peerId: '*' }],
    ['a peer id holding a backslash', { peerId: 'peer\\1' }],
    ['a lobby channel name', { channelName: 'udonarium-lobby-1-of-3' }],
    ['a channel name over 200 bytes', { channelName: 'あ'.repeat(67) }],
    ['a peer id over 200 bytes', { peerId: 'p'.repeat(201) }],
  ])('turns away %s', async (_name, change) => {
    const body = JSON.stringify({
      formatVersion: 1,
      channelName: 'room',
      peerId: 'peer-1',
      ...change,
    });
    const res = await buildApp().fetch(post('/skyway/tokens', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid request body.' },
    });
  });

  it('takes names of exactly 200 bytes', async () => {
    const body = JSON.stringify({
      formatVersion: 1,
      channelName: 'a'.repeat(200),
      peerId: 'p'.repeat(200),
    });
    const res = await buildApp().fetch(post('/skyway/tokens', body));
    expect(res.status).toBe(200);
  });
});
