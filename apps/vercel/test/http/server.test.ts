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
    const app = serverApp({ backendFor });
    const list = () =>
      app.fetch(
        new Request('https://backend.example/rooms', {
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
});
