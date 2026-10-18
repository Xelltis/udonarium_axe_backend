import { Hono } from 'hono';

import type { AppEnv } from '../../context.js';

export const statusRoute = new Hono<AppEnv>().get('/status', (c) => c.text('OK'));
