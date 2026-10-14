let rawEnv: Record<string, unknown> = {};

vi.mock('hono/adapter', () => ({
  env: () => rawEnv,
}));

import { createApp } from '../../src/http/app.js';

const baseEnv = {
  SKYWAY_APP_ID: 'app',
  SKYWAY_SECRET: 'secret',
  ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com',
};

describe('createApp', () => {
  beforeEach(() => {
    rawEnv = { ...baseEnv };
  });

  it('serves GET / without CORS or config requirements', async () => {
    rawEnv = {};
    const res = await createApp().fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello udonarium-backend-vercel!' });
  });

  it('serves GET /v1/status with a valid origin', async () => {
    const res = await createApp().fetch(
      new Request('http://localhost/v1/status', {
        headers: { Origin: 'https://example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('returns 400 ORIGIN_REQUIRED when no Origin header is sent to /v1/*', async () => {
    const res = await createApp().fetch(new Request('http://localhost/v1/status'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'ORIGIN_REQUIRED', message: 'Origin header is required.' },
    });
  });

  it('returns 403 ORIGIN_FORBIDDEN when Origin is not allow-listed', async () => {
    const res = await createApp().fetch(
      new Request('http://localhost/v1/status', {
        headers: { Origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 500 CONFIG_INVALID when env is missing', async () => {
    rawEnv = {};
    const res = await createApp().fetch(
      new Request('http://localhost/v1/status', {
        headers: { Origin: 'https://example.com' },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'CONFIG_INVALID', message: 'Invalid environment configuration.' },
    });
  });

  it('issues a JWT for POST /v1/skyway/tokens', async () => {
    const res = await createApp().fetch(
      new Request('http://localhost/v1/skyway/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ formatVersion: 1, channelName: 'room', peerId: 'peer-1' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('also issues a JWT for legacy POST /v1/skyway2023/token with Deprecation header', async () => {
    const res = await createApp().fetch(
      new Request('http://localhost/v1/skyway2023/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
        body: JSON.stringify({ formatVersion: 1, channelName: 'room', peerId: 'peer-1' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('true');
  });
});
