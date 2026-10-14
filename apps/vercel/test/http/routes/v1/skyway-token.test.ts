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
});
