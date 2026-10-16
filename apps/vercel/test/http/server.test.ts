import { describe, expect, it, vi } from 'vitest';

let rawEnv: Record<string, unknown> = {};

vi.mock('hono/adapter', () => ({
  env: () => rawEnv,
}));

import { serverApp } from '../../src/http/server.js';
import { storelessBackend } from '../../src/server/backend.js';

describe('serverApp', () => {
  it('reads the settings from the environment once, after they are right', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backendFor = vi.fn(async () => storelessBackend(new WeakMap()));
    const app = serverApp({ backendFor, sweep: async () => 0 });
    const list = () =>
      app.fetch(
        new Request('https://backend.example/v1/rooms', {
          headers: { Origin: 'https://app.example' },
        }),
      );

    rawEnv = {};
    const broken = await list();
    rawEnv = { ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example' };
    const listed = await list();
    rawEnv = {};
    const again = await list();

    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: 'config-invalid' });
    expect(await listed.json()).toEqual({ rooms: [] });
    expect(again.status).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('sweeps for Vercel Cron, only with its secret when one is set', async () => {
    const sweep = vi.fn(async () => 3);
    const app = serverApp({ backendFor: async () => storelessBackend(new WeakMap()), sweep });
    const call = (headers: Record<string, string> = {}) =>
      app.fetch(new Request('https://backend.example/internal/sweep', { headers }));
    rawEnv = { ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example', CRON_SECRET: 'cron-secret' };

    const without = await call();
    const wrong = await call({ Authorization: 'Bearer not-it' });
    const right = await call({ Authorization: 'Bearer cron-secret' });

    expect([without.status, wrong.status]).toEqual([401, 401]);
    expect(await right.json()).toEqual({ swept: 3 });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('sweeps for anyone when no secret is set', async () => {
    const app = serverApp({
      backendFor: async () => storelessBackend(new WeakMap()),
      sweep: async () => 0,
    });
    rawEnv = { ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example' };

    const res = await app.fetch(new Request('https://backend.example/internal/sweep'));

    expect(await res.json()).toEqual({ swept: 0 });
  });
});
