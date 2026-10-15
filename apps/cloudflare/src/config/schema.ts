import {
  check,
  integer,
  minValue,
  number,
  object,
  optional,
  pipe,
  string,
  transform,
} from 'valibot';

/** SESSION_SECRET の最短の長さ。HS256 の鍵として 256 ビット以上にする */
export const MIN_SESSION_SECRET_LENGTH = 32;

const LOGIN_KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'] as const;

export const envSchema = pipe(
  object({
    ACCESS_CONTROL_ALLOW_ORIGIN: string(),
    ROOM_RETENTION_HOURS: pipe(string(), transform(Number), number(), integer(), minValue(1)),
    DISCORD_CLIENT_ID: optional(string()),
    DISCORD_CLIENT_SECRET: optional(string()),
    SESSION_SECRET: optional(string()),
  }),
  // ログインの3つは、そろえて置くか、どれも置かないか
  check(
    (env) => new Set(LOGIN_KEYS.map((key) => Boolean(env[key]))).size === 1,
    'DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and SESSION_SECRET must be set together',
  ),
  check(
    (env) => !env.SESSION_SECRET || env.SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH,
    `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
  ),
);
