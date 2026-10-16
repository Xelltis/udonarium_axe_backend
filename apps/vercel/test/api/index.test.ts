vi.mock('hono/adapter', () => ({
  env: () => ({
    ENVIRONMENT: 'test',
    SKYWAY_APP_ID: 'appId',
    SKYWAY_SECRET: 'secret',
    SKYWAY_UDONARIUM_LOBBY_SIZE: '3',
    ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com',
  }),
}));

import type { AddressInfo } from 'node:net';

import server, { app } from '../../api/index.js';

describe('api entry', () => {
  // Vercel の Node.js ランタイムは、デフォルトエクスポートの HTTP サーバーに要求を渡す
  it('exposes a Node HTTP server that answers both the SkyWay and the room server routes', async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const root = await fetch(`http://127.0.0.1:${port}/`);
      const rooms = await fetch(`http://127.0.0.1:${port}/v1/rooms`, {
        headers: { Origin: 'https://example.com' },
      });

      expect(root.status).toBe(200);
      expect(await rooms.json()).toEqual({ rooms: [] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
