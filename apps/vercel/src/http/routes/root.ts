import { Hono } from 'hono';

export const rootRoute = new Hono().get('/', (c) =>
  c.json({ message: 'Hello udonarium-backend-vercel!' }),
);
