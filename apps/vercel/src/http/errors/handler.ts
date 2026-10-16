import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { AppError } from './app-error.js';

export const onError = (err: Error, c: Context) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  // Hono's JSON validator throws a 400 HTTPException when the body is broken JSON.
  if (err instanceof HTTPException && err.status === 400) {
    return c.json({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request body.' } }, 400);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error.' } }, 500);
};
