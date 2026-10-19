import { describe, expect, it, vi } from 'vitest';

let rawEnv: Record<string, unknown> = {};

vi.mock('hono/adapter', () => ({
  env: () => rawEnv,
}));

import { serverApp } from '../../src/http/server.js';
import type { ServerAppOptions } from '../../src/http/server.js';
import { storelessBackend } from '../../src/server/backend.js';

describe('serverApp', () => {
  it('reads the settings from the environment once, after they are right', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const backendFor = vi.fn(async () => storelessBackend(new WeakMap()));
    const app = serverApp({ backendFor, sweep: async () => ({ rooms: 0, assets: 0, storage: null }) });
    const list = () =>
      app.fetch(
        new Request('https://backend.example/v1/rooms', {
          headers: { Origin: 'https://app.example' },
        })
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
    const sweep = vi.fn<ServerAppOptions['sweep']>(async () => ({ rooms: 3, assets: 1, storage: null }));
    const app = serverApp({ backendFor: async () => storelessBackend(new WeakMap()), sweep });
    const call = (headers: Record<string, string> = {}) =>
      app.fetch(new Request('https://backend.example/internal/sweep', { headers }));
    rawEnv = { ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example', CRON_SECRET: 'cron-secret' };

    const without = await call();
    const wrong = await call({ Authorization: 'Bearer not-it' });
    const right = await call({ Authorization: 'Bearer cron-secret' });

    expect([without.status, wrong.status]).toEqual([401, 401]);
    expect(await right.json()).toEqual({ rooms: 3, assets: 1, storage: null });
    expect(sweep.mock.calls.map(([, keyed]) => keyed)).toEqual([true]);
  });

  it('sweeps for anyone when no secret is set, and says so when it swept a little while ago', async () => {
    const sweep = vi.fn<ServerAppOptions['sweep']>().mockResolvedValueOnce({ rooms: 0, assets: 0, storage: null });
    sweep.mockResolvedValueOnce(null);
    const app = serverApp({ backendFor: async () => storelessBackend(new WeakMap()), sweep });
    rawEnv = { ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example' };

    const first = await app.fetch(new Request('https://backend.example/internal/sweep'));
    const again = await app.fetch(new Request('https://backend.example/internal/sweep'));

    expect(await first.json()).toEqual({ rooms: 0, assets: 0, storage: null });
    expect(again.status).toBe(429);
    expect(sweep.mock.calls.map(([, keyed]) => keyed)).toEqual([false, false]);
  });
});
