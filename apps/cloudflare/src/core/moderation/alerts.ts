import { GB } from '../config/admin.js';
import type { Activity } from './activity.js';
import type { StorageUsage } from './storage.js';

/**
 * How long the same kind of alert is not sent again (milliseconds). Counted across every instance:
 * the store lets only one of them send it. Logins to the dashboard are sent every time.
 */
export const ALERT_MS = 10 * 60 * 1000;

/** How long the store's size is not told again: under a day, so that each daily count may tell it. */
export const STORAGE_ALERT_MS = 20 * 60 * 60 * 1000;

/** What is written down when an operator gets into the dashboard. */
export const ADMIN_LOGIN = 'login';

/** The start of what is written down when someone is turned away from the dashboard (and why follows). */
export const ADMIN_DENIED = 'denied';

/**
 * What the operator is told of as it happens:
 *
 * - limited: a sender went over a rate limit (a cost attack may be under way)
 * - refused: a banned sender or account came back
 * - admin-denied: someone was turned away from the dashboard
 * - admin-login: an operator got into the dashboard
 * - storage: the store of the rooms' pictures and sounds is past ADMIN_STORAGE_ALERT_GB
 */
export const ALERT_KINDS = ['limited', 'refused', 'admin-denied', 'admin-login', 'storage'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** What an alert says beyond its kind: who got into the dashboard, or how full the store is. */
export interface AlertFacts {
  name?: string;
  usage?: StorageUsage;
  limitBytes?: number;
}

/** A size in GB, as ADMIN_STORAGE_ALERT_GB is written. */
export const gbOf = (bytes: number): string => `${(bytes / GB).toFixed(2)} GB`;

/**
 * What the alert says. Only what happened, not who did it, except for the operator who got into the
 * dashboard: no participant's address or account goes to the webhook.
 */
const messageOf = (kind: AlertKind, facts: AlertFacts): string => {
  switch (kind) {
    case 'limited':
      return '部屋のサーバーで、回数の上限を超えた送信元があります。費用のかさむ使われかたかもしれません。管理画面の「概要」で確かめてください。（同じ知らせは10分に1回までです）';
    case 'refused':
      return '部屋のサーバーに、BANした送信元かアカウントがまた来ています。管理画面の「記録」で確かめてください。（同じ知らせは10分に1回までです）';
    case 'admin-denied':
      return '部屋のサーバーの管理画面に入ろうとして、断られた人がいます。心当たりが無ければ、管理画面の「記録」で確かめてください。（同じ知らせは10分に1回までです）';
    case 'admin-login':
      return `部屋のサーバーの管理画面に、${facts.name ?? '運営する人'}がログインしました。心当たりが無ければ、すぐに管理画面の「安全」から「すべての人をログアウトさせる」を押し、Discordのパスワードを替えてください。`;
    case 'storage': {
      const usage = facts.usage as StorageUsage;
      return `部屋のサーバーの画像と音声の置き場所が、知らせる量（${gbOf(facts.limitBytes as number)}）を超えました。いまは${gbOf(usage.bytes)}（${usage.assets}件）です。管理画面の「アップロード」の「場所を多く使っている部屋」で確かめてください。（この知らせは1日に1回までです）`;
    }
  }
};

/** The kind of alert something that happened calls for, or null when it calls for none. */
export const alertOf = (entry: Activity): AlertKind | null => {
  if (entry.kind === 'limited' || entry.kind === 'refused') return entry.kind;
  if (entry.kind !== 'admin') return null;
  if (entry.detail === ADMIN_LOGIN) return 'admin-login';
  return entry.detail?.startsWith(ADMIN_DENIED) ? 'admin-denied' : null;
};

/**
 * Sends alerts to a Discord webhook (ADMIN_WEBHOOK_URL). claim asks the store whether this instance
 * is the one to send this kind now. Throws when the webhook does not take it.
 */
export const webhookAlerts =
  (url: string, claim: (kind: AlertKind, ms: number) => Promise<boolean>) =>
  async (kind: AlertKind, facts: AlertFacts): Promise<void> => {
    if (kind !== 'admin-login' && !(await claim(kind, kind === 'storage' ? STORAGE_ALERT_MS : ALERT_MS))) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Nobody is mentioned, whatever the text says.
      body: JSON.stringify({ content: messageOf(kind, facts), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`The webhook answered ${res.status}`);
  };
