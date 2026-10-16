import {
  integer,
  minValue,
  number,
  object,
  optional,
  pipe,
  safeParse,
  string,
  summarize,
  transform,
} from 'valibot';

import {
  ConfigError,
  loginComplete,
  loginEntries,
  loginOf,
  sessionSecretLongEnough,
} from '../core/config/login.js';
import type { LoginConfig } from '../core/config/login.js';
import type { ServerConfig } from '../core/http/backend.js';

const HOUR_SECONDS = 60 * 60;

/** 最後の1人が出てから部屋を消すまでの時間の既定（時間） */
export const DEFAULT_ROOM_RETENTION_HOURS = 24;

/**
 * 部屋の WebSocket を、こちらから閉じてつなぎ直させるまでの既定（秒）。Vercel の Function は最大実行時間
 * （Hobby では 300 秒）で切れるので、それより前に自分で閉じる
 */
export const DEFAULT_ROOM_SOCKET_SECONDS = 280;

const MIN_ROOM_SOCKET_SECONDS = 60;

const DEFAULT_REDIS_KEY_PREFIX = 'axe:';

const integerOf = (fallback: number, least: number) =>
  optional(
    pipe(string(), transform(Number), number(), integer(), minValue(least)),
    String(fallback),
  );

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
  sessionSecretLongEnough(),
);

/** 部屋のアセットを置くところ */
export type BlobConfig = { kind: 'vercel' } | { kind: 'local'; dir: string };

/** Vercel 版の部屋のサーバーの設定 */
export interface VercelServerConfig extends ServerConfig {
  /** 部屋から最後の1人が出てから、部屋を消すまでの秒数 */
  roomRetentionSeconds: number;
  /** 部屋の WebSocket を、こちらから閉じてつなぎ直させるまでの秒数 */
  roomSocketSeconds: number;
  /** 部屋・一覧・アカウントを置く Redis。無ければ部屋は無い */
  redisUrl: string | null;
  redisKeyPrefix: string;
  blob: BlobConfig | null;
  /** Vercel Cron が掃除を呼ぶときの鍵。置かなければ確かめない */
  cronSecret: string | null;
}

/** 空の文字列は、置かなかったことにする */
const given = (value: string | undefined): string | null => (value ? value : null);

const blobOf = (env: {
  BLOB_READ_WRITE_TOKEN?: string;
  BLOB_STORE_ID?: string;
  BLOB_LOCAL_DIR?: string;
  VERCEL?: string;
}): BlobConfig | null => {
  const local = given(env.BLOB_LOCAL_DIR);
  if (local) {
    // 手元のディレクトリに置くのは、試すときだけ。Vercel の上では Function のファイルは残らない
    if (env.VERCEL === '1') throw new ConfigError('BLOB_LOCAL_DIR is for local runs only');
    return { kind: 'local', dir: local };
  }
  return given(env.BLOB_READ_WRITE_TOKEN) || given(env.BLOB_STORE_ID) ? { kind: 'vercel' } : null;
};

/**
 * 部屋のサーバーの設定を読む。形が違えば ConfigError。ログインを置くなら、部屋を置く Redis と、
 * 部屋のアセットを置く Blob も要る
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
