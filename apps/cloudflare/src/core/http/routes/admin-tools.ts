import type { Context, Hono } from 'hono';
import { array, boolean, maxLength, object, picklist, pipe, regex, safeParse, string } from 'valibot';

import { ASSET_ID } from '../../assets/keys.js';
import type { AdminConfig } from '../../config/admin.js';
import { TIGHTEN_WEIGHTS } from '../../moderation/bans.js';
import type { Pause, Tighten } from '../../moderation/bans.js';
import type { StorageUsage } from '../../moderation/storage.js';
import { recentPasskeyRequired } from '../admin-session.js';
import type { ServerEnv, StoredRoomAsset } from '../backend.js';
import { fail } from '../errors.js';
import { noteAdmin } from './admin-auth.js';
import { ROOM_KEY } from './rooms.js';

// What else the operator does from the dashboard: look through and take down what was uploaded,
// stop everyone for a while in an emergency, delete an account, and see the settings. Each needs a
// session a passkey has confirmed (the routes that call this have checked); what cannot be undone
// needs one confirmed recently.

type AdminContext = Context<ServerEnv>;

/** How many rooms one request to take an asset down everywhere names at most. */
const MAX_ROOMS_PER_TAKEDOWN = 2000;

/** A Discord user id. */
const DISCORD_ID = /^\d{1,20}$/;

const pauseSchema = object({ rooms: boolean(), uploads: boolean(), logins: boolean() });

const weight = picklist(TIGHTEN_WEIGHTS);
const tightenSchema = object({ upload: weight, read: weight, room: weight, auth: weight });

const takedownSchema = object({
  rooms: pipe(array(pipe(string(), regex(ROOM_KEY))), maxLength(MAX_ROOMS_PER_TAKEDOWN)),
});

/** The settings, as the dashboard shows them (no secret goes out). */
export interface AdminSettingsResponse {
  allowedOrigins: string[];
  roomRetentionHours: number;
  login: boolean;
  admins: string[];
  passkeyReset: string[];
  webhook: boolean;
  /** ADMIN_STORAGE_ALERT_GB in bytes, or null when the store is not counted. */
  storageAlertBytes: number | null;
}

/** The store's size as last counted, and the size past which the operator is told. */
export interface AdminStorageResponse {
  usage: StorageUsage | null;
  limitBytes: number | null;
}

export interface AdminAccountResponse {
  account: { discordId: string; userId: string; name: string; avatarUrl: string | null };
}

export interface AdminInventoryResponse {
  assets: StoredRoomAsset[];
  cursor: string | null;
}

/**
 * The headers of an asset handed to the operator to look at: shown as it is, never run. Only
 * pictures and sounds are stored (their type is found from the bytes), and the dashboard shows them
 * from a blob in an img or audio element.
 */
const VIEW_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'inline',
};

const assetIdOf = (c: AdminContext): string | null => {
  const id = c.req.param('id') as string;
  return ASSET_ID.test(id) ? id : null;
};

const roomKeyOf = (c: AdminContext): string | null => {
  const roomKey = c.req.param('roomKey') as string;
  return ROOM_KEY.test(roomKey) ? roomKey : null;
};

export const adminToolRoutes = (admin: Hono<ServerEnv>): void => {
  admin.get('/api/settings', (c) => {
    const { config } = c.var;
    const { discordIds, passkeyReset } = config.admin as AdminConfig;
    return c.json<AdminSettingsResponse>({
      allowedOrigins: config.allowedOrigins,
      roomRetentionHours: config.roomRetentionSeconds / 3600,
      login: config.login !== null,
      admins: discordIds,
      passkeyReset,
      webhook: config.adminWebhook !== null,
      storageAlertBytes: config.storageAlertBytes,
    });
  });

  /** The store's size as the daily count last found it (counted only when ADMIN_STORAGE_ALERT_GB is set). */
  admin.get('/api/storage', async (c) =>
    c.json<AdminStorageResponse>({
      usage: await c.var.backend.moderation.storageUsage(),
      limitBytes: c.var.config.storageAlertBytes,
    })
  );

  // ---- Stopping everyone for a while ----

  admin.get('/api/pause', async (c) =>
    c.json<{ pause: Pause }>({ pause: (await c.var.backend.moderation.fresh()).pause })
  );

  /** Stops (or starts again) making rooms, storing assets and logging in anew, on every instance at once. */
  admin.put('/api/pause', async (c) => {
    const parsed = safeParse(pauseSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const { rooms, uploads, logins } = parsed.output;
    const before = (await c.var.backend.moderation.fresh()).pause;
    const stopping = rooms || uploads || logins;
    const pause: Pause = { rooms, uploads, logins, since: stopping ? (before.since ?? Date.now()) : null };
    await c.var.backend.moderation.setPause(pause);
    const what = (['rooms', 'uploads', 'logins'] as const).filter((kind) => pause[kind]);
    noteAdmin(c, what.length > 0 ? `pause ${what.join(',')}` : 'resume');
    return c.json<{ pause: Pause }>({ pause });
  });

  // ---- Tightening the rate limits for a while ----

  admin.get('/api/tighten', async (c) =>
    c.json<{ tighten: Tighten }>({ tighten: (await c.var.backend.moderation.fresh()).tighten })
  );

  /**
   * Makes each rate limit as tight as set (each request counting 1, 2, 4 or 10 times), or lets them
   * go back. Every instance follows within BAN_CACHE_MS.
   */
  admin.put('/api/tighten', async (c) => {
    const parsed = safeParse(tightenSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const weights = parsed.output;
    const before = (await c.var.backend.moderation.fresh()).tighten;
    const tight = (['upload', 'read', 'room', 'auth'] as const).filter((kind) => weights[kind] > 1);
    const tighten: Tighten = { ...weights, since: tight.length > 0 ? (before.since ?? Date.now()) : null };
    await c.var.backend.moderation.setTighten(tighten);
    noteAdmin(c, tight.length > 0 ? `tighten ${tight.map((kind) => `${kind}=${weights[kind]}`).join(',')}` : 'loosen');
    return c.json<{ tighten: Tighten }>({ tighten });
  });

  // ---- Accounts ----

  admin.get('/api/accounts/:discordId', async (c) => {
    const discordId = c.req.param('discordId');
    if (!DISCORD_ID.test(discordId)) return fail(c, 400, 'invalid-id');
    const account = await c.var.backend.account(`discord:${discordId}`).account();
    if (!account) return fail(c, 404, 'not-found');
    return c.json<AdminAccountResponse>({ account: { discordId, ...account } });
  });

  /**
   * Deletes an account, as its owner can: its details and every token go. Seats it holds now stay
   * until their access token runs out; ban the account too to close them at once.
   */
  admin.delete('/api/accounts/:discordId', recentPasskeyRequired, async (c) => {
    const discordId = c.req.param('discordId');
    if (!DISCORD_ID.test(discordId)) return fail(c, 400, 'invalid-id');
    const port = c.var.backend.account(`discord:${discordId}`);
    const account = await port.account();
    if (!account || !(await port.erase(account.userId))) return fail(c, 404, 'not-found');
    noteAdmin(c, `delete account ${discordId}`);
    return c.body(null, 204);
  });

  // ---- What was uploaded ----

  /** One page of every room asset in the store. */
  admin.get('/api/assets', async (c) =>
    c.json<AdminInventoryResponse>(await c.var.backend.assets.inventory(c.req.query('cursor') || null))
  );

  /**
   * An asset's contents, for the operator to look at. What is put in a room is for those at that
   * table, so each look is written down, with who looked, for the other operators to see.
   */
  admin.get('/api/rooms/:roomKey/assets/:id/content', async (c) => {
    const roomKey = roomKeyOf(c);
    const id = assetIdOf(c);
    if (!roomKey || !id) return fail(c, 400, 'invalid-id');
    const content = await c.var.backend.assets.content(roomKey, id);
    if (!content) return fail(c, 404, 'not-found');
    noteAdmin(c, `view asset ${id}`, { roomKey });
    return new Response(content.body, { headers: { ...VIEW_HEADERS, 'Content-Type': content.type } });
  });

  /** Deletes an asset from one room. Someone in the room who has it may store it again. */
  admin.delete('/api/rooms/:roomKey/assets/:id', recentPasskeyRequired, async (c) => {
    const roomKey = roomKeyOf(c);
    const id = assetIdOf(c);
    if (!roomKey || !id) return fail(c, 400, 'invalid-id');
    await c.var.backend.assets.discard(roomKey, id);
    noteAdmin(c, `delete asset ${id}`, { roomKey });
    return c.body(null, 204);
  });

  /**
   * Bars an asset from being stored again, in any room, and deletes it from the rooms named (those
   * the dashboard found it in). Barred, the copies browsers still have cannot be put back.
   */
  admin.post('/api/assets/:id/block', recentPasskeyRequired, async (c) => {
    const id = assetIdOf(c);
    if (!id) return fail(c, 400, 'invalid-id');
    const parsed = safeParse(takedownSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, 400, 'invalid-request');
    const { assets } = c.var.backend;
    await assets.block(id);
    const deleting = await Promise.allSettled(parsed.output.rooms.map((roomKey) => assets.discard(roomKey, id)));
    const failed = deleting.filter((result) => result.status === 'rejected');
    for (const result of failed)
      console.error('Could not delete a barred asset:', (result as PromiseRejectedResult).reason);
    noteAdmin(c, `block asset ${id}`);
    return c.json({ deleted: deleting.length - failed.length, failed: failed.length });
  });

  admin.get('/api/blocked', async (c) => c.json({ ids: await c.var.backend.assets.blockedIds() }));

  /** Lets a barred asset be stored again. */
  admin.delete('/api/blocked/:id', recentPasskeyRequired, async (c) => {
    const id = assetIdOf(c);
    if (!id) return fail(c, 400, 'invalid-id');
    await c.var.backend.assets.unblock(id);
    noteAdmin(c, `unblock asset ${id}`);
    return c.body(null, 204);
  });
};
