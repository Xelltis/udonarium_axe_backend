import { check, optional, string } from 'valibot';

/** The shortest length of SESSION_SECRET. As an HS256 key it is kept at 256 bits or more. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** Logging in with Discord. Unless it is set, neither login nor rooms nor room assets can be used. */
export interface LoginConfig {
  discordClientId: string;
  discordClientSecret: string;
  /** The key that signs access tokens, invites and the state of a login under way. */
  sessionSecret: string;
}

/**
 * Environment variables are missing or in the wrong form. Every request gets a 500, and the reason
 * goes in the log.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOGIN_KEYS = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'] as const;

type LoginEnv = Partial<Record<(typeof LOGIN_KEYS)[number], string>>;

/** The three login entries, added to the schema of the environment variables. */
export const loginEntries = {
  DISCORD_CLIENT_ID: optional(string()),
  DISCORD_CLIENT_SECRET: optional(string()),
  SESSION_SECRET: optional(string()),
};

/** The three login entries are set all together or not at all. */
export const loginComplete = <T extends LoginEnv>() =>
  check<T, string>(
    (env) => new Set(LOGIN_KEYS.map((key) => Boolean(env[key]))).size === 1,
    'DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and SESSION_SECRET must be set together'
  );

export const sessionSecretLongEnough = <T extends LoginEnv>() =>
  check<T, string>(
    (env) => !env.SESSION_SECRET || env.SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH,
    `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`
  );

/** Makes the login settings from what has passed loginComplete and sessionSecretLongEnough. */
export const loginOf = (env: LoginEnv): LoginConfig | null =>
  env.SESSION_SECRET
    ? {
        discordClientId: env.DISCORD_CLIENT_ID as string,
        discordClientSecret: env.DISCORD_CLIENT_SECRET as string,
        sessionSecret: env.SESSION_SECRET,
      }
    : null;
