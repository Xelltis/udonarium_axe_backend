import { Hono } from 'hono';

// このファイルは hono/adapter を意図的にモックしない。
// Edge Runtime から Node.js ランタイムへの移行で変わったのは env() の解決先
// (getRuntimeKey() が 'edge-light' から 'node' になり process.env を読む) であり、
// 他のテストは全て env をモックしているためそこだけ実物で押さえる。
import { onError } from '../../../src/http/errors/handler.js';
import { configLoader } from '../../../src/http/middlewares/config-loader.js';
import type { AppEnv } from '../../../src/http/context.js';

describe('configLoader with the real hono/adapter env resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads configuration from process.env on the Node.js runtime', async () => {
    vi.stubEnv('SKYWAY_APP_ID', 'from-process-env');
    vi.stubEnv('SKYWAY_SECRET', 'secret');
    vi.stubEnv('ACCESS_CONTROL_ALLOW_ORIGIN', 'https://example.com');

    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.use('*', configLoader());
    app.get('/', (c) => c.json(c.var.config));

    const res = await app.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      skyway: { appId: string };
      cors: { allowedOrigins: string[] };
    };
    expect(body.skyway.appId).toBe('from-process-env');
    expect(body.cors.allowedOrigins).toEqual(['https://example.com']);
  });
});
