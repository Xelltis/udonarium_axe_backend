import { integer, minValue, number, object, optional, pipe, safeParse, string, summarize, transform } from 'valibot';

import { ConfigError, loginComplete, loginEntries, loginOf, sessionSecretLongEnough } from '../core/config/login.js';
import type { LoginConfig } from '../core/config/login.js';
import type { ServerConfig } from '../core/http/backend.js';

const HOUR_SECONDS = 60 * 60;

/** The default time from when the last person leaves until the room is deleted (in hours). */
export const DEFAULT_ROOM_RETENTION_HOURS = 24;

/**
 * The default time before the server closes a room's WebSocket itself and has it reconnect (in
 * seconds). A Vercel Function is cut off at its maximum duration (300 seconds on Hobby), so the
 * server closes it before that.
 */
export const DEFAULT_ROOM_SOCKET_SECONDS = 280;

const MIN_ROOM_SOCKET_SECONDS = 60;

const DEFAULT_REDIS_KEY_PREFIX = 'axe:';

const integerOf = (fallback: number, least: number) =>
  optional(pipe(string(), transform(Number), number(), integer(), minValue(least)), String(fallback));

const serverSchema = pipe(
  object({
    ACCESS_CONTROL_ALLOW_ORIGIN: string(),
    ROOM_RETENTION_HOURS: integerOf(DEFAULT_ROOM_RETENTION_HOURS, 1),
    ROOM_SOCKET_SECONDS: integerOf(DEFAULT_ROOM_SOCKET_SECONDS, MIN_ROOM_SOCKET_SECONDS),
    REDIS_URL: optional(string()),
    KV_URL: optional(string()),
    REDIS_KEY_PREFIX: optional(string()),
    BLOB_READ_WRITE_TOKEN: optional(string()),
    BLOB_STORE_ID: optional(string()),
    BLOB_LOCAL_DIR: optional(string()),
    CRON_SECRET: optional(string()),
    VERCEL: optional(string()),
    ...loginEntries,
  }),
  loginComplete(),
  sessionSecretLongEnough()
);

/** The store for the rooms' assets. */
export type BlobConfig = { kind: 'vercel' } | { kind: 'local'; dir: string };

/** The settings of the Vercel version's room server. */
export interface VercelServerConfig extends ServerConfig {
  /** Seconds from when the last person leaves a room until the room is deleted. */
  roomRetentionSeconds: number;
  /** Seconds before the server closes a room's WebSocket itself and has it reconnect. */
  roomSocketSeconds: number;
  /** The Redis that holds the rooms, the room list and the accounts. Without it there are no rooms. */
  redisUrl: string | null;
  redisKeyPrefix: string;
  blob: BlobConfig | null;
  /** The secret Vercel Cron sends when it calls the sweep. When it is not set, it is not checked. */
  cronSecret: string | null;
}

/** An empty string counts as not set. */
const given = (value: string | undefined): string | null => (value ? value : null);

const blobOf = (env: {
  BLOB_READ_WRITE_TOKEN?: string;
  BLOB_STORE_ID?: string;
  BLOB_LOCAL_DIR?: string;
  VERCEL?: string;
}): BlobConfig | null => {
  const local = given(env.BLOB_LOCAL_DIR);
  if (local) {
    // A local directory is only for trying things out. On Vercel, a Function's files do not last.
    if (env.VERCEL === '1') throw new ConfigError('BLOB_LOCAL_DIR is for local runs only');
    return { kind: 'local', dir: local };
  }
  return given(env.BLOB_READ_WRITE_TOKEN) || given(env.BLOB_STORE_ID) ? { kind: 'vercel' } : null;
};

/**
 * Reads the room server's settings. A ConfigError when they are not in the right shape. When login
 * is set up, the Redis that holds the rooms and the Blob store for the rooms' assets are needed too.
 */
export const parseServerConfig = (env: unknown): VercelServerConfig => {
  const result = safeParse(serverSchema, env);
  if (!result.success) {
    throw new ConfigError(`Invalid environment configuration:\n${summarize(result.issues)}`);
  }
  const parsed = result.output;
  const login: LoginConfig | null = loginOf(parsed);
  const redisUrl = given(parsed.REDIS_URL) ?? given(parsed.KV_URL);
  const blob = blobOf(parsed);
  if (login && !redisUrl) throw new ConfigError('REDIS_URL (or KV_URL) is needed for rooms');
  if (login && !blob) {
    throw new ConfigError('BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID is needed for room assets');
  }
  return {
    allowedOrigins: parsed.ACCESS_CONTROL_ALLOW_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    login,
    roomRetentionSeconds: parsed.ROOM_RETENTION_HOURS * HOUR_SECONDS,
    roomSocketSeconds: parsed.ROOM_SOCKET_SECONDS,
    redisUrl,
    redisKeyPrefix: given(parsed.REDIS_KEY_PREFIX) ?? DEFAULT_REDIS_KEY_PREFIX,
    blob,
    cronSecret: given(parsed.CRON_SECRET),
  };
};
