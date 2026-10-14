import { Hono } from 'hono';

import { onError } from '../../../src/http/errors/handler.js';
import { createCorsMiddleware } from '../../../src/http/middlewares/cors.js';
import type { AppEnv } from '../../../src/http/context.js';
import type { AppConfig } from '../../../src/config/types.js';

const stubConfig = (allowedOrigins: string[]): AppConfig => ({
  skyway: { appId: 'app', secret: 'secret', lobbySize: 3, tokenTtlSeconds: 86_400 },
  cors: { allowedOrigins },
  environment: undefined,
});

const buildApp = (allowedOrigins: string[]) => {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('*', async (c, next) => {
    c.set('config', stubConfig(allowedOrigins));
    await next();
  });
  app.use('*', createCorsMiddleware());
  app.get('/', (c) => c.text('ok'));
  return app;
};

describe('createCorsMiddleware', () => {
  it('returns 400 when Origin header is missing', async () => {
    const res = await buildApp(['https://example.com']).fetch(new Request('http://localhost/'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'ORIGIN_REQUIRED', message: 'Origin header is required.' },
    });
  });

  it('returns 403 when Origin is not in the allow list', async () => {
    const res = await buildApp(['https://example.com']).fetch(
      new Request('http://localhost/', { headers: { Origin: 'https://evil.example' } }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin is not allowed.' },
    });
  });

  it('allows requests from listed origins and sets CORS headers', async () => {
    const res = await buildApp(['https://example.com']).fetch(
      new Request('http://localhost/', { headers: { Origin: 'https://example.com' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });
});
