import { safeParse, summarize } from 'valibot';

import { adminOf, adminStorageAlertOf, adminWebhookOf } from '../core/config/admin';
import type { AdminConfig } from '../core/config/admin';
import { ConfigError, loginOf } from '../core/config/login';
import { roomStorageLimitOf } from '../core/config/rooms';
import type { LoginConfig } from '../core/config/login';
import { envSchema } from './schema';

export { ConfigError } from '../core/config/login';
export type { LoginConfig } from '../core/config/login';

const HOUR_SECONDS = 60 * 60;

export interface AppConfig {
  /** The Origins that rooms, assets and login take requests from. */
  allowedOrigins: string[];
  /** The seconds from the last person leaving a room until the room is deleted. */
  roomRetentionSeconds: number;
  login: LoginConfig | null;
  /** Who may open the operator's dashboard. Null when there is no dashboard. */
  admin: AdminConfig | null;
  /** The Discord webhook the operator's alerts go to. Null when there are no alerts. */
  adminWebhook: string | null;
  /** The store's size in bytes past which the operator is told. Null when it is not counted. */
  storageAlertBytes: number | null;
  /** The most one room may keep in bytes. Null when there is no such limit. */
  roomStorageLimitBytes: number | null;
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
    // envSchema has already checked that all three are there.
    login: loginOf(parsed),
    admin: adminOf(parsed),
    adminWebhook: adminWebhookOf(parsed),
    storageAlertBytes: adminStorageAlertOf(parsed),
    roomStorageLimitBytes: roomStorageLimitOf(parsed),
  };
};
