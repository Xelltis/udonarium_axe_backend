import { safeParse } from 'valibot';

import { AppError } from '../http/errors/app-error.js';
import { envSchema } from './schema.js';
import type { AppConfig } from './types.js';

export const parseConfig = (raw: unknown): AppConfig => {
  const result = safeParse(envSchema, raw);
  if (!result.success) {
    throw new AppError('CONFIG_INVALID', 500, 'Invalid environment configuration.');
  }
  const parsed = result.output;

  const allowedOrigins = parsed.ACCESS_CONTROL_ALLOW_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    skyway: {
      appId: parsed.SKYWAY_APP_ID,
      secret: parsed.SKYWAY_SECRET,
      lobbySize: parsed.SKYWAY_UDONARIUM_LOBBY_SIZE,
      tokenTtlSeconds: parsed.SKYWAY_TOKEN_TTL_SECONDS,
    },
    cors: { allowedOrigins },
    environment: parsed.ENVIRONMENT,
  };
};
