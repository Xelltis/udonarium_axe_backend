import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerBackend, ServerEnv, StoredRoomAsset } from '../../src/core/http/backend.js';
import { adminRoutes } from '../../src/core/http/routes/admin.js';
import type { AdminAccountResponse, AdminSettingsResponse } from '../../src/core/http/routes/admin-tools.js';
import type { Activity } from '../../src/core/moderation/activity.js';
import { noModeration } from '../../src/core/moderation/activity.js';
import type { Pause } from '../../src/core/moderation/bans.js';
import { harness } from '../harness.js';
import { ADMIN, callAdmin, sessionCookieOf } from './admin-helpers.js';
import { fakeDiscord, logIn, signInWithDiscord } from './auth-helpers.js';
import {
  ADMIN_ID,
  ORIGIN,
  OTHER_ROOM_KEY,
  ROOM_KEY,
  SESSION_SECRET,
  assetTokenFor,
  freshFile,
  freshIp,
  jsonOf,
} from './helpers.js';
import { ROOMS, eventually, postRoom, prepareAssetRooms } from './room-helpers.js';

// What else the operator does from the dashboard: settings, stopping everyone for a while,
// accounts, and what was uploaded.

afterEach(() => {
  vi.restoreAllMocks();
});

const stale = async () => sessionCookieOf({ verified: Math.floor(Date.now() / 1000) - 3600 });

const noted = (match: (entry: Activity) => boolean) =>
  eventually(
    async () => (await jsonOf<{ activity: Activity[] }>(await callAdmin('activity'))).activity,
    (entries) => entries.some(match)
  ).then((entries) => entries.filter(match));

/** Stores a file in a room, as a player there. */
const putIn = (roomKey: string, id: string, file: Uint8Array) =>
  harness.fetch(
    new Request(`${ROOMS}/${roomKey}/assets/${id}`, {
      method: 'PUT',
      body: file as Uint8Array<ArrayBuffer>,
      headers: {
        Origin: ORIGIN,
        'CF-Connecting-IP': freshIp(),
        'Content-Length': String(file.byteLength),
        Authorization: `Bearer ${assetTokenFor('pl', roomKey)}`,
      },
    })
  );

/** Every asset in the store, page after page. */
const inventory = async () => {
  const assets: StoredRoomAsset[] = [];
  let cursor: string | null = null;
  do {
    const page: { assets: StoredRoomAsset[]; cursor: string | null } = await jsonOf(
      await callAdmin(`assets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    );
    assets.push(...page.assets);
    cursor = page.cursor;
  } while (cursor !== null);
  return assets;
};

describe('the settings', () => {
  it('are shown without any secret', async () => {
    const settings = await jsonOf<AdminSettingsResponse>(await callAdmin('settings'));

    expect(settings).toEqual({
      allowedOrigins: expect.arrayContaining([ORIGIN]),
      roomRetentionHours: expect.any(Number),
      login: true,
      admins: [ADMIN_ID],
      passkeyReset: [],
      webhook: false,
    });
  });
});

describe('stopping everyone for a while', () => {
  it('stops making rooms, storing assets and logging in anew at once, and starts them again', async () => {
    const stopAll = { rooms: true, uploads: true, logins: true };
    try {
      expect((await jsonOf<{ pause: Pause }>(await callAdmin('pause'))).pause).toMatchObject({
        rooms: false,
        since: null,
      });
      const stopped = await jsonOf<{ pause: Pause }>(await callAdmin('pause', { method: 'PUT', body: stopAll }));
      expect(stopped.pause).toEqual({ ...stopAll, since: expect.any(Number) });
      const again = await jsonOf<{ pause: Pause }>(
        await callAdmin('pause', { method: 'PUT', body: { ...stopAll, logins: false } })
      );
      expect(again.pause.since).toBe(stopped.pause.since);
      await callAdmin('pause', { method: 'PUT', body: stopAll });

      const room = await postRoom({ name: 'stopped' });
      expect(room.status).toBe(503);
      expect(await room.json()).toEqual({ error: 'paused' });
      await prepareAssetRooms();
      const { file, id } = await freshFile();
      expect((await putIn(ROOM_KEY, id, file)).status).toBe(503);
      fakeDiscord();
      expect((await signInWithDiscord()).hash).toBe('#login_error=paused');
      expect((await jsonOf<{ pause: Pause }>(await callAdmin('pause'))).pause).toMatchObject(stopAll);
    } finally {
      const resumed = await jsonOf<{ pause: Pause }>(
        await callAdmin('pause', { method: 'PUT', body: { rooms: false, uploads: false, logins: false } })
      );
      expect(resumed.pause).toEqual({ rooms: false, uploads: false, logins: false, since: null });
    }

    expect((await postRoom({ name: 'going again' })).status).toBe(201);
    expect(await noted((entry) => entry.detail === 'pause rooms,uploads,logins')).not.toEqual([]);
    expect(await noted((entry) => entry.detail === 'resume')).not.toEqual([]);
    expect((await callAdmin('pause', { method: 'PUT', body: { rooms: 'yes' } })).status).toBe(400);
    expect((await callAdmin('pause', { method: 'PUT', body: '{' })).status).toBe(400);
  });
});

describe('accounts', () => {
  it('finds an account by its Discord id, and deletes it after a recent confirmation', async () => {
    const id = `3${String(Date.now()).padStart(17, '0')}`;
    const tokens = await logIn({ id, username: 'del', global_name: 'Del', avatar: null });

    const found = await jsonOf<AdminAccountResponse>(await callAdmin(`accounts/${id}`));
    expect(found.account).toEqual({ discordId: id, userId: tokens.account.userId, name: 'Del', avatarUrl: null });
    expect((await callAdmin(`accounts/${id}`, { method: 'DELETE', cookie: await stale() })).status).toBe(403);
    expect((await callAdmin(`accounts/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await callAdmin(`accounts/${id}`)).status).toBe(404);
    expect((await callAdmin(`accounts/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await callAdmin('accounts/someone')).status).toBe(400);
    expect((await callAdmin('accounts/someone', { method: 'DELETE' })).status).toBe(400);
    expect(await noted((entry) => entry.detail === `delete account ${id}`)).toHaveLength(1);
  });
});

describe('what was uploaded', () => {
  it('lists every room’s assets, shows one (writing down that it was looked at), and deletes one from a room after a recent confirmation', async () => {
    await prepareAssetRooms();
    const { file, id } = await freshFile();
    expect((await putIn(ROOM_KEY, id, file)).status).toBe(201);
    expect((await putIn(OTHER_ROOM_KEY, id, file)).status).toBe(201);

    const listed = (await inventory()).filter((asset) => asset.id === id);
    expect(listed.map((asset) => asset.roomKey).sort()).toEqual([OTHER_ROOM_KEY, ROOM_KEY].sort());
    expect(listed[0]).toEqual({
      roomKey: expect.any(String),
      id,
      type: 'image/png',
      size: file.byteLength,
      name: '',
      uploadedAt: expect.any(Number),
    });

    const shown = await callAdmin(`rooms/${ROOM_KEY}/assets/${id}/content`);
    expect(shown.headers.get('Content-Type')).toBe('image/png');
    expect(shown.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(file);
    expect(await noted((entry) => entry.detail === `view asset ${id}`)).toEqual([
      expect.objectContaining({ kind: 'admin', roomKey: ROOM_KEY, discordId: ADMIN_ID }),
    ]);
    expect((await callAdmin(`rooms/${ROOM_KEY}/assets/${'0'.repeat(64)}/content`)).status).toBe(404);
    expect((await callAdmin(`rooms/${ROOM_KEY}/assets/nope/content`)).status).toBe(400);

    expect(
      (await callAdmin(`rooms/${ROOM_KEY}/assets/${id}`, { method: 'DELETE', cookie: await stale() })).status
    ).toBe(403);
    expect((await callAdmin(`rooms/${ROOM_KEY}/assets/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await harness.assetStored(ROOM_KEY, id)).toBeNull();
    expect(await harness.assetStored(OTHER_ROOM_KEY, id)).not.toBeNull();
    expect((await callAdmin(`rooms/nope/assets/${id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it('takes an asset down from the rooms named and keeps it from being stored again, until it is let back', async () => {
    await prepareAssetRooms();
    const { file, id } = await freshFile();
    await putIn(ROOM_KEY, id, file);
    await putIn(OTHER_ROOM_KEY, id, file);

    const taken = await callAdmin(`assets/${id}/block`, {
      method: 'POST',
      body: { rooms: [ROOM_KEY, OTHER_ROOM_KEY] },
    });
    expect(await taken.json()).toEqual({ deleted: 2, failed: 0 });
    expect(await harness.assetStored(ROOM_KEY, id)).toBeNull();
    expect(await harness.assetStored(OTHER_ROOM_KEY, id)).toBeNull();
    expect((await putIn(ROOM_KEY, id, file)).status).toBe(451);
    expect((await jsonOf<{ ids: string[] }>(await callAdmin('blocked'))).ids).toContain(id);
    expect(await noted((entry) => entry.detail === `block asset ${id}`)).toHaveLength(1);

    expect((await callAdmin(`blocked/${id}`, { method: 'DELETE', cookie: await stale() })).status).toBe(403);
    expect((await callAdmin(`blocked/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await putIn(ROOM_KEY, id, file)).status).toBe(201);
    expect((await jsonOf<{ ids: string[] }>(await callAdmin('blocked'))).ids).not.toContain(id);
  });

  it('turns away a takedown or a release in the wrong form', async () => {
    expect((await callAdmin('assets/nope/block', { method: 'POST', body: { rooms: [] } })).status).toBe(400);
    expect((await callAdmin(`assets/${'a'.repeat(64)}/block`, { method: 'POST', body: { rooms: ['x'] } })).status).toBe(
      400
    );
    expect((await callAdmin('blocked/nope', { method: 'DELETE' })).status).toBe(400);
    expect((await callAdmin(`assets/${'a'.repeat(64)}/block`, { method: 'POST', body: '{' })).status).toBe(400);
  });

  it('goes on to the other rooms when one cannot be reached, and says so in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const discard = vi.fn().mockRejectedValueOnce(new Error('gone')).mockResolvedValueOnce(undefined);
    const backend = {
      addressOf: () => '192.0.2.1',
      assets: { block: async () => undefined, discard },
      moderation: noModeration,
    } as unknown as ServerBackend;
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('config', {
        allowedOrigins: [ORIGIN],
        login: { discordClientId: 'id', discordClientSecret: 'secret', sessionSecret: SESSION_SECRET },
        admin: { discordIds: [ADMIN_ID], passkeyReset: [] },
        adminWebhook: null,
        roomRetentionSeconds: 3600,
      });
      c.set('backend', backend);
      await next();
    });
    app.route('/admin', adminRoutes());

    const res = await app.fetch(
      new Request(`${ADMIN}/api/assets/${'b'.repeat(64)}/block`, {
        method: 'POST',
        headers: {
          'X-Admin-Request': '1',
          Cookie: await sessionCookieOf({ epoch: 0 }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rooms: [ROOM_KEY, OTHER_ROOM_KEY] }),
      })
    );

    expect(await res.json()).toEqual({ deleted: 1, failed: 1 });
    expect(error).toHaveBeenCalledWith('Could not delete a barred asset:', expect.any(Error));
  });
});
