import {
  createExecutionContext,
  createScheduledController,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_MS, MAX_ACTIVITY } from '../src/core/moderation/activity';
import type { Activity } from '../src/core/moderation/activity';
import type { Passkey } from '../src/core/admin/webauthn';
import type { Ban } from '../src/core/moderation/bans';
import { scheduled } from '../src/index';
import { MODERATION_NAME } from '../src/moderation/store';
import type { ModerationDurableObject } from '../src/moderation/store';
import type { LobbyDurableObject } from '../src/rooms/lobby';
import type { RoomDurableObject } from '../src/rooms/room';
import { harness } from './harness';
import { callAdmin } from './shared/admin-helpers';
import { freshIp } from './shared/helpers';
import { Client, createRoom, join } from './shared/room-helpers';
import { stubOf } from './cf-helpers';

// The Cloudflare version's side of the operator's bans: the Durable Object that keeps them, and what
// the rooms and the room list keep for the dashboard.

/** A store of its own, so that what one test keeps does not reach another. */
const freshStore = () => env.MODERATION.getByName(`test-${crypto.randomUUID()}`);

const banOf = (value: string, expiresAt: number | null): Ban => ({
  kind: 'discord',
  value,
  reason: '',
  createdAt: Date.now(),
  expiresAt,
});

const entryOf = (at: number, detail: string): Activity => ({ at, kind: 'admin', address: '192.0.2.1', detail });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the alerts', () => {
  it('go to the webhook when one is set, as when someone is turned away from the dashboard', async () => {
    const url = 'https://discord.example/api/webhooks/1/token';
    const start = await harness.fetch(
      new Request('https://backend.example/admin/login', {
        headers: { 'CF-Connecting-IP': freshIp() },
        redirect: 'manual',
      })
    );
    const state = new URL(start.headers.get('Location') as string).searchParams.get('state') as string;
    const cookie = (start.headers.getSetCookie()[0] as string).split(';')[0];
    const sent = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const at = input instanceof Request ? input.url : String(input);
      if (at === 'https://discord.com/api/oauth2/token')
        return Response.json({ access_token: 't', token_type: 'Bearer' });
      if (at === 'https://discord.com/api/v10/users/@me')
        return Response.json({ id: '7', username: 'x', mfa_enabled: true });
      return new Response(null, { status: 204 });
    });

    const res = await harness.fetchWith(
      new Request(`https://backend.example/admin/login/callback?code=c&state=${state}`, {
        headers: { Cookie: cookie, 'CF-Connecting-IP': freshIp() },
        redirect: 'manual',
      }),
      { ADMIN_WEBHOOK_URL: url }
    );

    expect(res.headers.get('Location')).toBe('/admin#denied=not-allowed');
    expect(sent).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST' }));
  });
});

describe('the daily count of the store', () => {
  const url = 'https://discord.example/api/webhooks/1/token';
  const theStore = () => env.MODERATION.getByName(MODERATION_NAME);
  const run = async (overrides: Record<string, string>) => {
    const ctx = createExecutionContext();
    await scheduled(createScheduledController(), { ...env, ...overrides } as Env, ctx);
    await waitOnExecutionContext(ctx);
  };

  it('counts the store and tells the operator when it is past the amount set', async () => {
    await env.ASSETS.put(`rooms/${'a'.repeat(32)}/${'b'.repeat(64)}`, new Uint8Array(10));
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await run({ ADMIN_STORAGE_ALERT_GB: '0.000000001', ADMIN_WEBHOOK_URL: url });

    expect(await theStore().storageUsage()).toMatchObject({ bytes: expect.any(Number), complete: true });
    expect(sent).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST' }));
  });

  it('counts nothing without an amount, and logs settings it cannot read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const before = await theStore().storageUsage();
    await run({});
    expect(await theStore().storageUsage()).toEqual(before);
    await run({ ADMIN_STORAGE_ALERT_GB: 'many' });

    expect(error).toHaveBeenCalledWith('Could not count the store:', expect.any(Error));
  });
});

describe('ModerationDurableObject', () => {
  it('keeps the operators’ passkeys oldest first, the generation of their sessions, and challenges taken', async () => {
    const store = freshStore();
    const passkeyOf = (id: string, discordId: string, createdAt: number): Passkey => ({
      id,
      discordId,
      publicKey: 'key',
      algorithm: -7,
      name: id,
      createdAt,
      usedAt: null,
      signCount: 0,
    });
    for (const passkey of [
      passkeyOf('b', '1', 2),
      passkeyOf('a', '1', 2),
      passkeyOf('c', '1', 1),
      passkeyOf('d', '2', 1),
    ]) {
      await store.putPasskey(passkey);
    }

    expect((await store.passkeysOf('1')).map((passkey) => passkey.id)).toEqual(['c', 'a', 'b']);
    expect(await store.passkey('d')).toMatchObject({ discordId: '2' });
    expect(await store.passkey('z')).toBeNull();
    expect(await store.deletePasskey('d')).toBe(true);
    expect(await store.deletePasskey('d')).toBe(false);
    expect(await store.adminEpoch()).toBe(0);
    expect(await store.raiseAdminEpoch()).toBe(1);
    expect(await store.adminEpoch()).toBe(1);
    expect(await store.takeChallenge('x', 60_000)).toBe(true);
    expect(await store.takeChallenge('x', 60_000)).toBe(false);
  });

  it('keeps what the operator stopped, and when, until it is started again', async () => {
    const store = freshStore();

    expect((await store.state()).pause).toEqual({ rooms: false, uploads: false, logins: false, since: null });
    await store.setPause({ rooms: true, uploads: false, logins: true, since: 7 });
    expect((await store.state()).pause).toEqual({ rooms: true, uploads: false, logins: true, since: 7 });
    await store.setPause({ rooms: false, uploads: false, logins: false, since: null });
    expect((await store.state()).pause).toEqual({ rooms: false, uploads: false, logins: false, since: null });
  });

  it('lets a challenge be taken again once it has run out', async () => {
    const store = freshStore();

    expect(await store.takeChallenge('y', 0)).toBe(true);
    expect(await store.takeChallenge('y', 0)).toBe(true);
  });

  it('keeps the store’s size as last counted', async () => {
    const store = freshStore();

    expect(await store.storageUsage()).toBeNull();
    await store.putStorageUsage({ bytes: 12_345_678_901, assets: 7, at: 3, complete: false });
    expect(await store.storageUsage()).toEqual({ bytes: 12_345_678_901, assets: 7, at: 3, complete: false });
    await store.putStorageUsage({ bytes: 1, assets: 1, at: 4, complete: true });
    expect(await store.storageUsage()).toEqual({ bytes: 1, assets: 1, at: 4, complete: true });
  });

  it('lets one instance send each kind of alert once in a while', async () => {
    const store = freshStore();

    expect(await store.claimAlert('limited', 60_000)).toBe(true);
    expect(await store.claimAlert('limited', 60_000)).toBe(false);
    expect(await store.claimAlert('refused', 60_000)).toBe(true);
    expect(await store.claimAlert('limited', 0)).toBe(true);
  });

  it('lets a ban past its end go when the bans are read', async () => {
    const store = freshStore();
    await store.putBan(banOf('1', Date.now() - 1));
    await store.putBan(banOf('2', Date.now() + 60_000));
    await store.putBan(banOf('3', null));

    expect((await store.bans()).map((ban) => ban.value).sort()).toEqual(['2', '3']);
    expect(
      await runInDurableObject(
        store,
        (_instance: ModerationDurableObject, state) =>
          state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM bans').one().n
      )
    ).toBe(2);
  });

  it('keeps the newest MAX_ACTIVITY, and nothing older than ACTIVITY_MS', async () => {
    const store = freshStore();
    const now = Date.now();
    const kept = await runInDurableObject(store, (instance: ModerationDurableObject, state) => {
      instance.note(entryOf(now - ACTIVITY_MS - 1, 'too old'));
      for (let i = 0; i <= MAX_ACTIVITY; i++) instance.note(entryOf(now, `n${i}`));
      return state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM activity').one().n;
    });
    const activity = await store.activity();

    expect(kept).toBe(MAX_ACTIVITY);
    expect(activity).toHaveLength(MAX_ACTIVITY);
    expect(activity[0].detail).toBe(`n${MAX_ACTIVITY}`);
    expect(activity.at(-1)?.detail).toBe('n1');
  });

  it('does not show what has grown too old since it was written', async () => {
    const store = freshStore();
    await runInDurableObject(store, (_instance: ModerationDurableObject, state) => {
      state.storage.sql.exec(
        "INSERT INTO activity (at, kind, address) VALUES (?, 'login', '192.0.2.1')",
        Date.now() - ACTIVITY_MS - 1
      );
    });

    expect(await store.activity()).toEqual([]);
  });
});

describe('the room list for the operator', () => {
  it('lets go of who made a room along with the room', async () => {
    const lobby = env.LOBBY.getByName(`test-${crypto.randomUUID()}`);
    const room = { roomKey: 'r1', roomId: 'abc', name: 'r', hasPassword: false, members: 0 };
    await lobby.register(room, { accountKey: 'discord:42', address: '192.0.2.1' });
    await lobby.setMembers('r1', 2);

    expect(await lobby.all()).toEqual([
      {
        ...room,
        members: 2,
        createdAt: expect.any(Number),
        creator: { accountKey: 'discord:42', address: '192.0.2.1' },
      },
    ]);
    expect(await lobby.occupied()).toEqual(['r1']);

    await lobby.remove('r1');

    expect(
      await runInDurableObject(
        lobby,
        (_instance: LobbyDurableObject, state) =>
          state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM creators').one().n
      )
    ).toBe(0);
    expect(await lobby.occupied()).toEqual([]);
  });
});

describe('a room seen by the operator', () => {
  it('keeps no address for a connection that came without one', async () => {
    const roomKey = await createRoom();
    const res = await stubOf(roomKey).fetch(
      new Request(`https://backend.example/v1/rooms/${roomKey}/ws`, { headers: { Upgrade: 'websocket' } })
    );
    const ws = res.webSocket as WebSocket;
    ws.binaryType = 'arraybuffer';
    ws.accept();
    const client = new Client({
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      onMessage: (listener) => ws.addEventListener('message', (event) => listener(event.data as ArrayBuffer)),
      onClose: (listener) => ws.addEventListener('close', (event) => listener(event.code, event.reason)),
    });
    client.hello('quiet', { accessToken: null });
    await client.next('welcome');

    const [seat] = await stubOf(roomKey).seats();

    expect(seat).toMatchObject({ peerId: 'quiet', account: false });
    expect(seat.address).toBeUndefined();
  });

  it('writes down a deletion by the operator as one', async () => {
    const roomKey = await createRoom();
    await join(roomKey, 'alice');
    const points: AnalyticsEngineDataPoint[] = [];
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      const metrics = { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) };
      (instance as unknown as { env: Env }).env = { ...env, METRICS: metrics } as unknown as Env;
    });

    const res = await callAdmin(`rooms/${roomKey}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(points.find((point) => point.blobs?.[1] === 'delete')?.blobs).toEqual([
      'backend.example',
      'delete',
      'operator',
    ]);
  });
});
