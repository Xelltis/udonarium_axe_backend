import { check, optional, string } from 'valibot';

/** The bytes in one GB, as the stores bill them. */
export const GB = 1_000_000_000;

/**
 * The operator's dashboard and its alerts, added to the schema of the environment variables.
 *
 * - ADMIN_DISCORD_IDS: the Discord user ids of those who may open the dashboard, separated by commas.
 *   Without it there is no dashboard.
 * - ADMIN_PASSKEY_RESET: those of them who may register a passkey without one they have (for when an
 *   operator has lost every device). Set it only while they need it.
 * - ADMIN_WEBHOOK_URL: the Discord webhook the alerts go to. Without it there are no alerts.
 * - ADMIN_STORAGE_ALERT_GB: the store's size, in GB, past which the operator is told (counted once
 *   a day). Without it the store is not counted.
 * - ADMIN_CONTACT_URL: where someone the operator turned away can ask about it (an https:// page or
 *   a mailto: address). Without it none is given.
 */
export const adminEntries = {
  ADMIN_DISCORD_IDS: optional(string()),
  ADMIN_PASSKEY_RESET: optional(string()),
  ADMIN_WEBHOOK_URL: optional(string()),
  ADMIN_STORAGE_ALERT_GB: optional(string()),
  ADMIN_CONTACT_URL: optional(string()),
};

interface AdminEnv {
  ADMIN_DISCORD_IDS?: string;
  ADMIN_PASSKEY_RESET?: string;
  ADMIN_WEBHOOK_URL?: string;
  ADMIN_STORAGE_ALERT_GB?: string;
  ADMIN_CONTACT_URL?: string;
}

/** The ids in a list separated by commas. */
const idsOf = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

/** A Discord user id (a snowflake: a whole number written in decimal). */
const DISCORD_ID = /^\d{1,20}$/;

/** The ids are Discord user ids. */
export const adminIdsValid = <T extends AdminEnv>() =>
  check<T, string>(
    (env) => [...idsOf(env.ADMIN_DISCORD_IDS), ...idsOf(env.ADMIN_PASSKEY_RESET)].every((id) => DISCORD_ID.test(id)),
    'ADMIN_DISCORD_IDS and ADMIN_PASSKEY_RESET must be Discord user ids separated by commas'
  );

/** The scheme of a URL, or null when it is not one. */
const schemeOf = (text: string): string | null => {
  try {
    return new URL(text).protocol;
  } catch {
    return null;
  }
};

const isHttps = (text: string): boolean => schemeOf(text) === 'https:';

/** The webhook the alerts go to is an https:// URL (a Discord webhook). */
export const adminWebhookValid = <T extends AdminEnv>() =>
  check<T, string>(
    (env) => !env.ADMIN_WEBHOOK_URL || isHttps(env.ADMIN_WEBHOOK_URL),
    'ADMIN_WEBHOOK_URL must be an https:// URL'
  );

/** Where to ask is an https:// page or a mailto: address. */
export const adminContactValid = <T extends AdminEnv>() =>
  check<T, string>(
    (env) => !env.ADMIN_CONTACT_URL || ['https:', 'mailto:'].includes(schemeOf(env.ADMIN_CONTACT_URL) ?? ''),
    'ADMIN_CONTACT_URL must be an https:// or mailto: URL'
  );

/** Where someone turned away can ask, from what has passed adminContactValid. Null when unset. */
export const adminContactOf = (env: AdminEnv): string | null => env.ADMIN_CONTACT_URL || null;

/** A size in GB above nothing, as written (a decimal point is allowed: 0.5). */
const GB_AMOUNT = /^\d+(\.\d+)?$/;

/** The store's size to tell the operator past is a number of GB above nothing. */
export const adminStorageAlertValid = <T extends AdminEnv>() =>
  check<T, string>(
    (env) =>
      env.ADMIN_STORAGE_ALERT_GB === undefined ||
      env.ADMIN_STORAGE_ALERT_GB === '' ||
      (GB_AMOUNT.test(env.ADMIN_STORAGE_ALERT_GB) && Number(env.ADMIN_STORAGE_ALERT_GB) > 0),
    'ADMIN_STORAGE_ALERT_GB must be a number of GB above 0'
  );

/** Who may open the dashboard. */
export interface AdminConfig {
  /** The Discord user ids of the operators. */
  discordIds: string[];
  /** Those of them who may register a passkey without one they have. */
  passkeyReset: string[];
}

/** The dashboard's settings, from what has passed adminIdsValid. Null when there is no dashboard. */
export const adminOf = (env: AdminEnv): AdminConfig | null => {
  const discordIds = idsOf(env.ADMIN_DISCORD_IDS);
  return discordIds.length > 0 ? { discordIds, passkeyReset: idsOf(env.ADMIN_PASSKEY_RESET) } : null;
};

/** The webhook the alerts go to, from what has passed adminWebhookValid. Null when unset. */
export const adminWebhookOf = (env: AdminEnv): string | null => env.ADMIN_WEBHOOK_URL || null;

/** The store's size in bytes to tell the operator past, from what has passed adminStorageAlertValid. Null when unset. */
export const adminStorageAlertOf = (env: AdminEnv): number | null =>
  env.ADMIN_STORAGE_ALERT_GB ? Math.round(Number(env.ADMIN_STORAGE_ALERT_GB) * GB) : null;
