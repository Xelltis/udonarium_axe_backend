import { Hono } from 'hono';

import type { AppEnv } from '../../context.js';
import { skywayTokenRoute } from './skyway-token.js';
import { statusRoute } from './status.js';

export const v1Routes = new Hono<AppEnv>().route('/', statusRoute).route('/', skywayTokenRoute);
