import type { Context } from 'hono';

import { AppError } from './app-error.js';

export const onError = (err: Error, c: Context) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error.' } }, 500);
};
