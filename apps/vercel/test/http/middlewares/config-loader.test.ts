import { Hono } from 'hono';

let rawEnv: Record<string, unknown> = {};

vi.mock('hono/adapter', () => ({
  env: () => rawEnv,
}));

import { onError } from '../../../src/http/errors/handler.js';
import { configLoader } from '../../../src/http/middlewares/config-loader.js';
import type { AppEnv } from '../../../src/http/context.js';

const buildApp = () => {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('*', configLoader());
  app.get('/', (c) => c.json(c.var.config));
  return app;
};

describe('configLoader middleware', () => {
  it('parses env and stores AppConfig on the context', async () => {
    rawEnv = {
      SKYWAY_APP_ID: 'app',
      SKYWAY_SECRET: 'secret',
      ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com',
    };
    const res = await buildApp().fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skyway: { appId: string; lobbySize: number; tokenTtlSeconds: number };
      cors: { allowedOrigins: string[] };
    };
    expect(body.skyway.appId).toBe('app');
    expect(body.skyway.lobbySize).toBe(3);
    expect(body.skyway.tokenTtlSeconds).toBe(86_400);
    expect(body.cors.allowedOrigins).toEqual(['https://example.com']);
  });

  it('parses the environment once and reuses it for subsequent requests', async () => {
    rawEnv = {
      SKYWAY_APP_ID: 'app',
      SKYWAY_SECRET: 'secret',
      ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com',
    };
    const app = buildApp();
    const first = await app.fetch(new Request('http://localhost/'));

    // 2 回目のリクエストではキャッシュが使われるため、env が差し替わっても影響しない
    rawEnv = {};
    const second = await app.fetch(new Request('http://localhost/'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  it('surfaces CONFIG_INVALID through the error handler when env is invalid', async () => {
    rawEnv = {};
    const res = await buildApp().fetch(new Request('http://localhost/'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'CONFIG_INVALID', message: 'Invalid environment configuration.' },
    });
  });
});
