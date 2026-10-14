vi.mock('hono/adapter', () => ({
  env: () => ({
    ENVIRONMENT: 'test',
    SKYWAY_APP_ID: 'appId',
    SKYWAY_SECRET: 'secret',
    SKYWAY_UDONARIUM_LOBBY_SIZE: '3',
    ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com',
  }),
}));

import handler, { app } from '../../api/index.js';

describe('api entry', () => {
  // @vercel/node は default export が `fetch` を持つ場合のみ Web Standard
  // ハンドラとして扱い、素の関数だと Node の (req, res) ハンドラと誤検出する。
  it('exposes a fetch handler as the default export for the Vercel Node.js runtime', async () => {
    expect(typeof handler.fetch).toBe('function');

    const res = await handler.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
  });

  it('responds to /', async () => {
    const res = await app.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('message');
  });

  it('serves v1 status endpoint', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/status', {
        headers: { Origin: 'https://example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('issues a token at the legacy path /v1/skyway2023/token', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/skyway2023/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ formatVersion: 1, channelName: 'room', peerId: 'peer-1' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('token');
  });

  it('issues a token at the new path /v1/skyway/tokens', async () => {
    const res = await app.fetch(
      new Request('http://localhost/v1/skyway/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ formatVersion: 1, channelName: 'room', peerId: 'peer-1' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('token');
  });
});
