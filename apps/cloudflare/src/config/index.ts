import { safeParse, summarize } from 'valibot';

import { ConfigError, loginOf } from '../core/config/login';
import type { LoginConfig } from '../core/config/login';
import { envSchema } from './schema';

export { ConfigError } from '../core/config/login';
export type { LoginConfig } from '../core/config/login';

const HOUR_SECONDS = 60 * 60;

export interface AppConfig {
  /** 部屋とアセットとログインを受ける Origin */
  allowedOrigins: string[];
  /** 部屋から最後の1人が出てから、部屋を消すまでの秒数 */
  roomRetentionSeconds: number;
  login: LoginConfig | null;
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
    roomRetentionSeconds: parsed.ROOM_RETENTION_HOURS * HOUR_SECONDS,
    // 3つがそろっていることは envSchema で確かめてある
    login: loginOf(parsed),
  };
};
