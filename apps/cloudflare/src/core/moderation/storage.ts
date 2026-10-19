import type { ServerBackend, ServerConfig, StoredRoomAsset } from '../http/backend.js';

/** How full the store of the rooms' pictures and sounds was when last counted. */
export interface StorageUsage {
  /** The bytes they take up. */
  bytes: number;
  /** How many there are. */
  assets: number;
  /** When they were counted (Unix milliseconds). */
  at: number;
  /** False when the count stopped at MAX_STORAGE_PAGES pages, short of the end. */
  complete: boolean;
}

/** How many pages of the store one count reads at most, so that it ends in time however big the store. */
export const MAX_STORAGE_PAGES = 10_000;

/** Counts every room asset in the store, a page at a time. */
export const countStorage = async (
  inventory: (cursor: string | null) => Promise<{ assets: StoredRoomAsset[]; cursor: string | null }>
): Promise<StorageUsage> => {
  let bytes = 0;
  let assets = 0;
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await inventory(cursor);
    for (const asset of page.assets) bytes += asset.size;
    assets += page.assets.length;
    cursor = page.cursor;
    pages++;
  } while (cursor !== null && pages < MAX_STORAGE_PAGES);
  return { bytes, assets, at: Date.now(), complete: cursor === null };
};

/**
 * The daily check (a cron trigger on Cloudflare, Vercel Cron's sweep on Vercel): when
 * ADMIN_STORAGE_ALERT_GB is set, counts the store, keeps the count for the dashboard, and tells the
 * operator when it is past that amount. Returns the count, or null when nothing is set to count for.
 */
export const checkStorage = async (
  config: Pick<ServerConfig, 'storageAlertBytes'>,
  backend: Pick<ServerBackend, 'assets' | 'moderation'>
): Promise<StorageUsage | null> => {
  if (config.storageAlertBytes === null) return null;
  const usage = await countStorage((cursor) => backend.assets.inventory(cursor));
  await backend.moderation.putStorageUsage(usage);
  if (usage.bytes > config.storageAlertBytes) await backend.moderation.alertStorage(usage, config.storageAlertBytes);
  return usage;
};
