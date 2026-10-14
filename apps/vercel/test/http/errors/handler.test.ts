import { Hono } from 'hono';

import { AppError } from '../../../src/http/errors/app-error.js';
import { onError } from '../../../src/http/errors/handler.js';

const buildApp = (thrown: unknown) => {
  const app = new Hono();
  app.onError(onError);
  app.get('/', () => {
    throw thrown;
  });
  return app;
};

describe('onError', () => {
  it('returns AppError status + JSON body for AppError', async () => {
    const app = buildApp(new AppError('VALIDATION_FAILED', 422, 'nope'));
    const res = await app.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'nope' },
    });
  });

  it('logs and returns 500 INTERNAL_ERROR for unknown errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = buildApp(new Error('boom'));
      const res = await app.fetch(new Request('http://localhost/'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error.' },
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
