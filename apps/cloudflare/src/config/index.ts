import { safeParse, summarize } from 'valibot';

import { envSchema } from './schema';

const HOUR_SECONDS = 60 * 60;

/** Discord でのログイン。置かなければ、ログインも部屋も部屋のアセットも使えない */
export interface LoginConfig {
  discordClientId: string;
  discordClientSecret: string;
  /** アクセストークン・招待・ログインの途中の状態に署名する鍵 */
  sessionSecret: string;
}

export interface AppConfig {
  /** 部屋とアセットとログインを受ける Origin */
  allowedOrigins: string[];
  /** 部屋から最後の1人が出てから、部屋を消すまでの秒数 */
  roomRetentionSeconds: number;
  login: LoginConfig | null;
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
    roomRetentionSeconds: parsed.ROOM_RETENTION_HOURS * HOUR_SECONDS,
    // 3つがそろっていることは envSchema で確かめてある
    login: parsed.SESSION_SECRET
      ? {
          discordClientId: parsed.DISCORD_CLIENT_ID as string,
          discordClientSecret: parsed.DISCORD_CLIENT_SECRET as string,
          sessionSecret: parsed.SESSION_SECRET,
        }
      : null,
  };
};
