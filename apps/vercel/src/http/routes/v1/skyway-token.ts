import { Hono } from 'hono';
import { vValidator } from '@hono/valibot-validator';
import type { Context } from 'hono';

import { issueSkywayToken } from '../../../domain/skyway/token.js';
import { encode as base64UrlEncode } from '../../../infra/encoding/base64url.js';
import { hmacSHA256 } from '../../../infra/crypto/hmac.js';
import { uuid } from '../../../infra/crypto/uuid.js';
import { AppError } from '../../errors/app-error.js';
import type { AppEnv } from '../../context.js';
import { skywayTokenRequestSchema } from './schemas.js';

const issueAndRespond = async (
  c: Context<AppEnv>,
  body: { channelName: string; peerId: string },
) => {
  const token = await issueSkywayToken(
    { channelName: body.channelName, peerId: body.peerId },
    {
      config: c.var.config.skyway,
      uuid,
      now: () => Math.floor(Date.now() / 1000),
      hmacSHA256,
      encode: base64UrlEncode,
    },
  );
  return c.json({ token }, 200);
};

const validator = vValidator('json', skywayTokenRequestSchema, (result) => {
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Invalid request body.');
  }
});

export const skywayTokenRoute = new Hono<AppEnv>()
  .post('/skyway/tokens', validator, async (c) => issueAndRespond(c, c.req.valid('json')))
  .post('/skyway2023/token', validator, async (c) => {
    c.header('Deprecation', 'true');
    c.header('Link', '</v1/skyway/tokens>; rel="successor-version"');
    return issueAndRespond(c, c.req.valid('json'));
  });
