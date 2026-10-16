import { check, optional, string } from 'valibot';

/** SESSION_SECRET の最短の長さ。HS256 の鍵として 256 ビット以上にする */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** Discord でのログイン。置かなければ、ログインも部屋も部屋のアセットも使えない */
export interface LoginConfig {
  discordClientId: string;
  discordClientSecret: string;
  /** アクセストークン・招待・ログインの途中の状態に署名する鍵 */
  sessionSecret: string;
}

/** 環境変数が足りないか、形が違う。どのリクエストにも 500 を返し、理由はログに書く */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOGIN_KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'] as const;

type LoginEnv = Partial<Record<(typeof LOGIN_KEYS)[number], string>>;

/** 環境変数のスキーマに足す、ログインの3つ */
export const loginEntries = {
  DISCORD_CLIENT_ID: optional(string()),
  DISCORD_CLIENT_SECRET: optional(string()),
  SESSION_SECRET: optional(string()),
};

/** ログインの3つは、そろえて置くか、どれも置かないか */
export const loginComplete = <T extends LoginEnv>() =>
  check<T, string>(
    (env) => new Set(LOGIN_KEYS.map((key) => Boolean(env[key]))).size === 1,
    'DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and SESSION_SECRET must be set together',
  );

export const sessionSecretLongEnough = <T extends LoginEnv>() =>
  check<T, string>(
    (env) => !env.SESSION_SECRET || env.SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH,
    `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
  );

/** loginComplete と sessionSecretLongEnough を通ったものから、ログインの設定を作る */
export const loginOf = (env: LoginEnv): LoginConfig | null =>
  env.SESSION_SECRET
    ? {
        discordClientId: env.DISCORD_CLIENT_ID as string,
        discordClientSecret: env.DISCORD_CLIENT_SECRET as string,
        sessionSecret: env.SESSION_SECRET,
      }
    : null;
