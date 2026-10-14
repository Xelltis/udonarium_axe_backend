import { safeParse, summarize } from 'valibot';

import { envSchema } from './schema';

export interface AppConfig {
  /** PUT を受ける Origin */
  allowedOrigins: string[];
}

/** 環境変数が足りないか、形が違う。どのリクエストにも 500 を返し、理由はログに書く */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const parseConfig = (env: unknown): AppConfig => {
  const result = safeParse(envSchema, env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${summarize(result.issues)}`);
  }
  const parsed = result.output;

  return {
    allowedOrigins: parsed.ACCESS_CONTROL_ALLOW_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
};
