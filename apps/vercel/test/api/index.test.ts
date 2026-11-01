import type { AddressInfo } from 'node:net';

import server, { app } from '../../api/index.js';

// The entry reads process.env, as it does on Vercel. Without REDIS_URL (which CI sets for the
// other tests) the room server keeps no rooms. unstubEnvs puts process.env back before each test.
beforeEach(() => {
  vi.stubEnv('ENVIRONMENT', 'test');
  vi.stubEnv('SKYWAY_APP_ID', 'appId');
  vi.stubEnv('SKYWAY_SECRET', 'secret');
  vi.stubEnv('SKYWAY_UDONARIUM_LOBBY_SIZE', '3');
  vi.stubEnv('ACCESS_CONTROL_ALLOW_ORIGIN', 'https://example.com');
  vi.stubEnv('REDIS_URL', undefined);
});

describe('api entry', () => {
  // The Vercel Node.js runtime hands requests to the HTTP server that is the default export.
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
      })
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
      })
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
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('token');
  });
});
