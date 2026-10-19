import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RoomAsset, TokenResponse } from '../../contracts/protocol.js';
import { ASSET_TOKEN_SECONDS, signToken } from '../../src/core/auth/tokens.js';
import type { ServerBackend, ServerEnv } from '../../src/core/http/backend.js';
import { adminRoutes } from '../../src/core/http/routes/admin.js';
import type { AdminRoomView, AdminSeat } from '../../src/core/http/routes/admin.js';
import { SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from '../../src/core/http/admin-session.js';
import { serverRoutes } from '../../src/core/http/routes/index.js';
import { noModeration } from '../../src/core/moderation/activity.js';
import type { Activity } from '../../src/core/moderation/activity.js';
import { BanList } from '../../src/core/moderation/bans.js';
import type { Ban } from '../../src/core/moderation/bans.js';
import { harness } from '../harness.js';
import { ADMIN, SESSION_COOKIE, callAdmin, sessionCookieOf } from './admin-helpers.js';
import { APP, BACKEND, callApi, fakeDiscord, logIn, navigate, signInWithDiscord } from './auth-helpers.js';
import {
  ADMIN_ID,
  BASE,
  ORIGIN,
  PNG_HEAD,
  ROOM_KEY,
  SESSION_SECRET,
  accessTokenFor,
  assetTokenFor,
  freshFile,
  freshIp,
  jsonOf,
  put,
  withinOneWindow,
} from './helpers.js';
import {
  Client,
  ROOMS,
  createRoom,
  eventually,
  listRooms,
  postRoom,
  prepareAssetRooms,
  upgrade,
} from './room-helpers.js';

// The operator's dashboard, the bans it makes, and what it writes down.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Calls the dashboard's API, as an operator a passkey has just confirmed unless told otherwise. */
const admin = callAdmin;

const banOf = async (kind: Ban['kind'], value: string, extra: Record<string, unknown> = {}) => {
  const res = await admin('bans', { method: 'POST', body: { kind, value, ...extra } });
  expect(res.status).toBe(201);
  return (await jsonOf<{ ban: Ban }>(res)).ban;
};

const unban = (ban: Pick<Ban, 'kind' | 'value'>) =>
  admin(`bans?kind=${ban.kind}&value=${encodeURIComponent(ban.value)}`, { method: 'DELETE' });

const bans = async () => (await jsonOf<{ bans: Ban[] }>(await admin('bans'))).bans;

const activity = async () => (await jsonOf<{ activity: Activity[] }>(await admin('activity'))).activity;

/** Waits until so many are written down that match. Writing them goes on after the response. */
const noted = (match: (entry: Activity) => boolean, count = 1) =>
  eventually(activity, (entries) => entries.filter(match).length >= count).then((entries) => entries.filter(match));

/** A Discord user id no other test uses. */
const freshDiscordId = () => `9${Array.from(crypto.getRandomValues(new Uint8Array(17)), (byte) => byte % 10).join('')}`;

/** The rooms as the dashboard lists them. */
const adminRooms = async () => (await jsonOf<{ rooms: AdminRoomView[] }>(await admin('rooms'))).rooms;

const seatsOf = async (roomKey: string) =>
  (await jsonOf<{ seats: AdminSeat[] }>(await admin(`rooms/${roomKey}/seats`))).seats;

/** Comes into a room from that address, as join does. */
const joinFrom = async (roomKey: string, ip: string, peerId: string, extra: Record<string, unknown> = {}) => {
  const res = await upgrade(roomKey, { 'CF-Connecting-IP': ip });
  if (!res.socket) throw new Error(`not upgraded: ${res.status}`);
  const client = new Client(res.socket);
  client.hello(peerId, extra);
  await client.next('welcome');
  await client.events();
  return client;
};

/** Waits until the room list shows that many in the room. News for the list arrives after the response. */
const peopleIn = (roomKey: string, members: number) =>
  eventually(listRooms, (rooms) => rooms.some((room) => room.roomKey === roomKey && room.members === members));

describe('the dashboard page', () => {
  it('is there only while operators are set', async () => {
    const env = { ADMIN_DISCORD_IDS: undefined };
    const page = await harness.fetchWith(new Request(ADMIN), env);
    const api = await admin('bans', { env });

    expect(page.status).toBe(404);
    expect(await page.json()).toEqual({ error: 'not-found' });
    expect(api.status).toBe(404);
  });

  it('runs only the style and script carrying the nonce its policy names, and stays out of caches and frames', async () => {
    const first = await harness.fetch(new Request(ADMIN));
    const second = await harness.fetch(new Request(`${ADMIN}/`));
    const policy = first.headers.get('Content-Security-Policy') as string;
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1] as string;
    const html = await first.text();

    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(second.headers.get('Content-Security-Policy')).not.toBe(policy);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(first.headers.get('X-Frame-Options')).toBe('DENY');
    expect(first.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(first.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('the dashboard API', () => {
  it('answers only the page itself: with its header, and from its own origin when the browser says', async () => {
    const withoutHeader = await harness.fetch(
      new Request(`${ADMIN}/api/bans`, { headers: { Cookie: await sessionCookieOf(), 'CF-Connecting-IP': freshIp() } })
    );
    const fromElsewhere = await admin('bans', { headers: { Origin: 'https://evil.example' } });
    const fromHere = await admin('bans', { headers: { Origin: BACKEND } });

    expect(withoutHeader.status).toBe(403);
    expect(await withoutHeader.json()).toEqual({ error: 'forbidden' });
    expect(fromElsewhere.status).toBe(403);
    expect(fromHere.status).toBe(200);
  });

  it('answers 401 login-required without a session that is still good, and takes the cookie away', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const cookie of [
      null,
      `${SESSION_COOKIE}=not-a-token`,
      await sessionCookieOf({ sub: '999' }),
      await sessionCookieOf({ epoch: (await harness.adminEpoch()) - 1 }),
      await sessionCookieOf({ seconds: -1, start: now - 3600 }),
    ]) {
      const res = await admin('rooms', { cookie });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'login-required' });
      expect(res.headers.getSetCookie().join()).toMatch(/__Host-axe-admin=;.*Max-Age=0/);
    }
  });

  it('lets a session Discord alone let in do nothing but confirm a passkey', async () => {
    const res = await admin('rooms', { cookie: await sessionCookieOf({ stage: 'discord' }) });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'passkey-required' });
  });

  it('puts the end of a confirmed session off with each call, but not past its longest', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = await admin('bans', { cookie: await sessionCookieOf({ start: now }) });
    const old = await admin('bans', { cookie: await sessionCookieOf({ start: now - SESSION_MAX_SECONDS + 60 }) });

    expect(fresh.headers.getSetCookie().join()).toMatch(new RegExp(`Max-Age=${SESSION_IDLE_SECONDS}`));
    expect(fresh.headers.getSetCookie().join()).toMatch(/HttpOnly/);
    expect(fresh.headers.getSetCookie().join()).toMatch(/SameSite=Strict/);
    expect(old.headers.getSetCookie().join()).toMatch(/Max-Age=(59|60);/);
  });

  it('answers 503 while login is not set up', async () => {
    const res = await admin('bans', {
      env: { DISCORD_CLIENT_ID: undefined, DISCORD_CLIENT_SECRET: undefined, SESSION_SECRET: undefined },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'login-unavailable' });
  });
});

describe('bans', () => {
  it('bans a range in the one form it keeps, lists it, lifts it, and writes both down', async () => {
    const ban = await banOf('ip', '203.0.113.77/24', { reason: 'flood', hours: 2 });

    expect(ban).toEqual({
      kind: 'ip',
      value: '203.0.113.0/24',
      reason: 'flood',
      createdAt: expect.any(Number),
      expiresAt: ban.createdAt + 2 * 60 * 60 * 1000,
    });
    expect(await bans()).toContainEqual(ban);
    expect((await unban(ban)).status).toBe(204);
    expect((await unban(ban)).status).toBe(404);
    expect(await bans()).not.toContainEqual(ban);
    expect(
      await noted((entry) => entry.kind === 'admin' && entry.detail?.endsWith('ip 203.0.113.0/24') === true, 2)
    ).toEqual([
      expect.objectContaining({ detail: 'unban ip 203.0.113.0/24' }),
      expect.objectContaining({ detail: 'ban ip 203.0.113.0/24' }),
    ]);
  });

  it('keeps a ban with no end until it is lifted, with an empty reason when none is given', async () => {
    const id = freshDiscordId();
    const ban = await banOf('discord', id);

    expect(ban).toMatchObject({ kind: 'discord', value: id, reason: '', expiresAt: null });
    expect((await unban(ban)).status).toBe(204);
  });

  it.each([
    ['a body that is not JSON', 'nope'],
    ['a kind it does not know', { kind: 'email', value: 'a@example.com' }],
    ['an address it cannot read', { kind: 'ip', value: '203.0.113' }],
    ['a range too wide', { kind: 'ip', value: '10.0.0.0/7' }],
    ['a Discord id that is not one', { kind: 'discord', value: 'kai' }],
    ['no time at all', { kind: 'discord', value: '42', hours: 0 }],
    ['a reason too long', { kind: 'discord', value: '42', reason: 'x'.repeat(201) }],
  ])('turns away %s', async (_name, body) => {
    const res = await admin('bans', { method: 'POST', body });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-request' });
  });

  it.each([
    ['no kind', 'bans?value=42'],
    ['a kind it does not know', 'bans?kind=email&value=42'],
    ['no value', 'bans?kind=discord'],
  ])('turns away a lifting with %s', async (_name, path) => {
    expect((await admin(path, { method: 'DELETE' })).status).toBe(400);
  });
});

describe('a banned sender', () => {
  it('is turned away from rooms, login and tokens, and can still reach the dashboard', async () => {
    const ip = freshIp();
    const ban = await banOf('ip', ip);
    const from = (path: string, init: RequestInit = {}) =>
      harness.fetch(
        new Request(`${BACKEND}${path}`, {
          ...init,
          headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...init.headers },
        })
      );

    const list = await from('/v1/rooms');
    expect(list.status).toBe(403);
    expect(await list.json()).toEqual({ error: 'banned' });
    expect((await from('/v1/auth/config')).status).toBe(403);
    expect(
      (await from('/v1/auth/token', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }))
        .status
    ).toBe(403);
    const ws = await upgrade(ROOM_KEY, { 'CF-Connecting-IP': ip });
    expect(ws.status).toBe(403);
    expect(await ws.json()).toEqual({ error: 'banned' });
    expect((await callApi('/v1/rooms')).status).toBe(200);
    expect((await admin('bans', { ip })).status).toBe(200);

    expect(await noted((entry) => entry.kind === 'refused' && entry.address === ip)).toEqual([
      expect.objectContaining({ kind: 'refused', address: ip, detail: `ip ${ip}/32` }),
    ]);

    expect((await unban(ban)).status).toBe(204);
    expect((await from('/v1/rooms')).status).toBe(200);
  });

  it('is sent back from the login with banned, at its start and on its way back', async () => {
    const ip = freshIp();
    const discord = fakeDiscord({ id: freshDiscordId(), username: 'mal', global_name: null, avatar: null });
    const start = await navigate(
      `/v1/login/discord?redirect_uri=${encodeURIComponent(APP)}&code_challenge=${'c'.repeat(43)}`
    );
    const state = new URL(start.headers.get('Location') as string).searchParams.get('state');
    const ban = await banOf('ip', ip);

    const startBanned = await navigate(
      `/v1/login/discord?redirect_uri=${encodeURIComponent(APP)}&code_challenge=${'c'.repeat(43)}`,
      ip
    );
    const backBanned = await navigate(`/v1/login/discord/callback?code=discord-code&state=${state}`, ip);

    expect(startBanned.status).toBe(302);
    expect(startBanned.headers.get('Location')).toBe(`${APP}#login_error=banned`);
    expect(backBanned.headers.get('Location')).toBe(`${APP}#login_error=banned`);
    expect(discord).not.toHaveBeenCalled();
    await unban(ban);
  });

  it('is closed out of the rooms it is in, and the others stay', async () => {
    const roomKey = await createRoom();
    const ip = freshIp();
    const alice = await joinFrom(roomKey, freshIp(), 'alice');
    const guest = await joinFrom(roomKey, ip, 'stranger', { accessToken: null });
    await alice.next('join');
    await peopleIn(roomKey, 2);

    const ban = await banOf('ip', ip);

    expect(await guest.next('error')).toMatchObject({ code: 'banned' });
    expect(await guest.closed).toEqual({ code: 4000, reason: 'banned' });
    expect(await alice.next('leave')).toEqual({ type: 'leave', peerId: 'stranger' });
    await alice.expectQuiet();
    await unban(ban);
  });
});

describe('a banned account', () => {
  it('gets no tokens, makes no rooms, reaches no assets and cannot log in, until the ban is lifted', async () => {
    const id = freshDiscordId();
    const user = { id, username: 'mal', global_name: 'Mal', avatar: null };
    const tokens: TokenResponse = await logIn(user);
    const assetToken = signToken<'asset'>(
      { aud: 'asset', room: ROOM_KEY, role: 'pl', uid: tokens.account.userId, sub: `discord:${id}` },
      ASSET_TOKEN_SECONDS,
      SESSION_SECRET
    );
    const asset = (path = '', method = 'GET') =>
      harness.fetch(
        new Request(`${BASE}${path}`, {
          method,
          headers: {
            Origin: ORIGIN,
            'CF-Connecting-IP': freshIp(),
            Authorization: `Bearer ${assetToken}`,
            ...(method === 'PUT' ? { 'Content-Length': '8' } : {}),
          },
          body: method === 'PUT' ? new Uint8Array(PNG_HEAD) : undefined,
        })
      );
    const refresh = () =>
      callApi('/v1/auth/token', {
        method: 'POST',
        body: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
      });
    expect((await asset(`/${'a'.repeat(64)}`)).status).toBe(404);

    const ban = await banOf('discord', id);

    const refused = await refresh();
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid-grant' });
    const room = await postRoom({ name: 'mine' }, { Authorization: `Bearer ${tokens.accessToken}` });
    expect(room.status).toBe(403);
    expect(await room.json()).toEqual({ error: 'banned' });
    for (const [path, method] of [
      [`/${'a'.repeat(64)}`, 'GET'],
      [`/${'a'.repeat(64)}`, 'HEAD'],
      ['', 'GET'],
    ]) {
      expect((await asset(path, method)).status).toBe(403);
    }
    const put = await asset(`/${'a'.repeat(64)}`, 'PUT');
    expect(put.status).toBe(403);
    const discord = fakeDiscord(user);
    const back = await signInWithDiscord();
    expect(back.hash).toBe('#login_error=banned');
    expect(discord).toHaveBeenCalledTimes(2);
    expect(await noted((entry) => entry.kind === 'refused' && entry.discordId === id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ detail: `discord ${id}` })])
    );

    expect((await unban(ban)).status).toBe(204);
    expect((await refresh()).status).toBe(200);
  });

  it('is closed out of the rooms it is in', async () => {
    const roomKey = await createRoom();
    const id = freshDiscordId();
    const alice = await joinFrom(roomKey, freshIp(), 'alice');
    const mal = await joinFrom(roomKey, freshIp(), 'mal', { userId: id, accessToken: accessTokenFor(id) });
    await alice.next('join');
    await peopleIn(roomKey, 2);

    const ban = await banOf('discord', id);

    expect(await mal.next('error')).toMatchObject({ code: 'banned' });
    expect(await alice.next('leave')).toEqual({ type: 'leave', peerId: 'mal' });
    await unban(ban);
  });
});

describe('a ban made on another instance', () => {
  /** Lists the rooms from that address, which only reads. */
  const listFrom = (ip: string) =>
    harness.fetch(new Request(ROOMS, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } }));

  /** Says hello to the room from that address, and gives the first answer. */
  const helloFrom = async (roomKey: string, ip: string, peerId: string, extra: Record<string, unknown> = {}) => {
    const res = await upgrade(roomKey, { 'CF-Connecting-IP': ip });
    if (!res.socket) throw new Error(`not upgraded: ${res.status}`);
    const client = new Client(res.socket);
    client.hello(peerId, extra);
    return (await client.nextRaw()).message;
  };

  const banNow = (kind: Ban['kind'], value: string): Ban => ({
    kind,
    value,
    reason: '',
    createdAt: Date.now(),
    expiresAt: null,
  });

  it('turns the sender away at once from coming into a room and making one, while reading goes by the bans read before', async () => {
    const roomKey = await createRoom();
    const ip = freshIp();
    expect((await listFrom(ip)).status).toBe(200);
    const ban = banNow('ip', `${ip}/32`);

    await harness.banElsewhere(ban);

    expect((await listFrom(ip)).status).toBe(200);
    // The upgrade only reads, so it goes through on the bans read before. The hello does not.
    expect(await helloFrom(roomKey, ip, 'stranger', { accessToken: null })).toMatchObject({
      type: 'error',
      code: 'banned',
    });
    const made = await postRoom({ name: 'mine' }, { 'CF-Connecting-IP': ip });
    expect(made.status).toBe(403);
    expect(await made.json()).toEqual({ error: 'banned' });
    expect((await unban(ban)).status).toBe(204);
  });

  it('keeps an account out of rooms at once, even with an access token still good', async () => {
    const roomKey = await createRoom();
    const id = freshDiscordId();
    const tokens = await logIn({ id, username: 'mal', global_name: 'Mal', avatar: null });
    expect(await helloFrom(roomKey, freshIp(), 'mal', { userId: id, accessToken: accessTokenFor(id) })).toMatchObject({
      type: 'welcome',
    });
    const ban = banNow('discord', id);

    await harness.banElsewhere(ban);

    expect(await helloFrom(roomKey, freshIp(), 'mal', { userId: id, accessToken: accessTokenFor(id) })).toMatchObject({
      type: 'error',
      code: 'banned',
    });
    const refreshed = await callApi('/v1/auth/token', {
      method: 'POST',
      body: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
    });
    expect(await refreshed.json()).toEqual({ error: 'invalid-grant' });
    expect((await unban(ban)).status).toBe(204);
  });
});

describe('rooms on the dashboard', () => {
  it('lists the rooms with who made them, and who is in them now', async () => {
    const id = freshDiscordId();
    const ip = freshIp();
    const made = await postRoom(
      { name: 'by mal' },
      { Authorization: `Bearer ${accessTokenFor(id)}`, 'CF-Connecting-IP': ip }
    );
    const { roomKey } = await jsonOf<{ roomKey: string }>(made);
    const seatIp = freshIp();
    await joinFrom(roomKey, seatIp, 'pat', { userId: id, accessToken: accessTokenFor(id) });

    const listed = (await adminRooms()).find((room) => room.roomKey === roomKey);
    expect(listed).toEqual({
      roomKey,
      roomId: expect.any(String),
      name: 'by mal',
      hasPassword: false,
      members: expect.any(Number),
      createdAt: expect.any(Number),
      creator: { discordId: id, address: ip },
    });
    expect(
      await eventually(
        () => seatsOf(roomKey),
        (seats) => seats.length === 1
      )
    ).toEqual([
      {
        peerId: 'pat',
        userId: id,
        role: 'gm',
        account: true,
        discordId: id,
        address: seatIp,
        joinedAt: expect.any(Number),
      },
    ]);
  });

  it('lists a room kept before who made it was, with no one as its maker', async () => {
    const roomKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    await harness.createRoom({
      roomKey,
      roomId: 'old',
      name: 'old',
      password: 'pw',
      creatorUserId: 'u',
      host: 'backend.example',
    });

    expect((await adminRooms()).find((room) => room.roomKey === roomKey)).toMatchObject({
      hasPassword: true,
      creator: null,
    });
    expect(await seatsOf(roomKey)).toEqual([]);
  });

  it('deletes a room whoever its GM is, closing those in it', async () => {
    const roomKey = await createRoom();
    const alice = await joinFrom(roomKey, freshIp(), 'alice');

    const deleted = await admin(`rooms/${roomKey}`, { method: 'DELETE' });

    expect(deleted.status).toBe(204);
    expect(await alice.next('error')).toMatchObject({ code: 'room-deleted' });
    expect((await admin(`rooms/${roomKey}`, { method: 'DELETE' })).status).toBe(404);
    expect(await noted((entry) => entry.kind === 'admin' && entry.roomKey === roomKey)).toEqual([
      expect.objectContaining({ detail: 'delete room' }),
    ]);
  });

  it('shows no address for a seat that came in before addresses were kept', async () => {
    const roomKey = await createRoom();
    await joinFrom(roomKey, freshIp(), 'alice');
    await harness.inside(roomKey, ({ host }) => {
      for (const conn of host.connections()) {
        const seat = host.seatOf(conn);
        if (!seat) continue;
        const older = { ...seat };
        delete older.address;
        host.setSeat(conn, older);
      }
    });

    expect(
      await eventually(
        () => seatsOf(roomKey),
        (seats) => seats[0]?.address === null
      )
    ).toEqual([expect.objectContaining({ peerId: 'alice', address: null })]);
  });

  it('lists the images and sounds kept in a room', async () => {
    await prepareAssetRooms();
    const { file, id } = await freshFile();
    expect((await put(id, file)).status).toBe(201);

    const res = await admin(`rooms/${ROOM_KEY}/assets`);

    expect(res.status).toBe(200);
    expect((await jsonOf<{ assets: RoomAsset[] }>(res)).assets).toContainEqual(
      expect.objectContaining({ id, type: 'image/png', size: file.byteLength })
    );
    expect((await admin('rooms/not-a-key/assets')).status).toBe(400);
  });

  it('turns away a room key in the wrong form', async () => {
    expect((await admin('rooms/nope/seats')).status).toBe(400);
    expect((await admin('rooms/nope', { method: 'DELETE' })).status).toBe(400);
  });
});

describe('what is written down', () => {
  it('writes down logins, rooms made, assets stored and senders over a limit', async () => {
    const id = freshDiscordId();
    await logIn({ id, username: 'kai', global_name: 'Kai', avatar: null });
    const ip = freshIp();
    const made = await postRoom(
      { name: 'noted' },
      { Authorization: `Bearer ${accessTokenFor(id)}`, 'CF-Connecting-IP': ip }
    );
    const { roomKey } = await jsonOf<{ roomKey: string }>(made);
    await prepareAssetRooms();
    const { file, id: assetId } = await freshFile(PNG_HEAD, 300);
    const stored = await harness.fetch(
      new Request(`${BASE}/${assetId}`, {
        method: 'PUT',
        body: file,
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': ip,
          'Content-Length': String(file.byteLength),
          Authorization: `Bearer ${assetTokenFor('pl')}`,
        },
      })
    );
    expect(stored.status).toBe(201);
    // Two over the limit, written down once.
    const limitedIp = await withinOneWindow(async (each) => {
      for (let i = 0; i < 7; i++) {
        await harness.fetch(new Request(ROOMS, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': each } }));
      }
      return each;
    });

    expect(await noted((entry) => entry.kind === 'login' && entry.discordId === id)).toEqual([
      expect.objectContaining({ name: 'Kai' }),
    ]);
    expect(await noted((entry) => entry.kind === 'room' && entry.roomKey === roomKey)).toEqual([
      { at: expect.any(Number), kind: 'room', address: ip, discordId: id, name: id, roomKey, detail: 'noted' },
    ]);
    expect(await noted((entry) => entry.kind === 'upload' && entry.address === ip)).toEqual([
      {
        at: expect.any(Number),
        kind: 'upload',
        address: ip,
        roomKey: ROOM_KEY,
        detail: expect.stringMatching(/^image\/png 300 [0-9a-f]{64}$/),
      },
    ]);
    expect(await noted((entry) => entry.kind === 'limited' && entry.address === limitedIp)).toEqual([
      { at: expect.any(Number), kind: 'limited', address: limitedIp, detail: 'read' },
    ]);
  });
});

describe('reading the bans as they stand', () => {
  it('waits until a request has a good token or grant and is within its limit', async () => {
    const fresh = vi.fn(async () => new BanList([]));
    let within = true;
    let goodGrant = false;
    const session = {
      account: { userId: 'acct_x', name: 'x' },
      accountKey: 'discord:1',
      refreshToken: { id: 'id', secret: 'next' },
    };
    const backend = {
      addressOf: () => '192.0.2.1',
      limit: async () => within,
      account: () => ({ refresh: async () => (goodGrant ? session : null) }),
      rooms: { create: async () => undefined },
      moderation: { ...noModeration, fresh },
    } as unknown as ServerBackend;
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('config', {
        allowedOrigins: [ORIGIN],
        login: { discordClientId: 'id', discordClientSecret: 'secret', sessionSecret: SESSION_SECRET },
        admin: null,
        adminWebhook: null,
        roomRetentionSeconds: 3600,
      });
      c.set('backend', backend);
      await next();
    });
    app.route('/v1', serverRoutes());
    const call = (path: string, body: unknown, token?: string) =>
      app.fetch(
        new Request(`${BACKEND}${path}`, {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        })
      );
    const grant = { grant_type: 'refresh_token', refresh_token: 'ZGlzY29yZDox.id.secret' };

    expect((await call('/v1/rooms', { name: 'x' })).status).toBe(401);
    expect((await call('/v1/auth/token', grant)).status).toBe(400);
    within = false;
    expect((await call('/v1/rooms', { name: 'x' }, accessTokenFor('x'))).status).toBe(429);
    expect(fresh).not.toHaveBeenCalled();

    within = true;
    goodGrant = true;
    expect((await call('/v1/rooms', { name: 'x' }, accessTokenFor('x'))).status).toBe(201);
    expect((await call('/v1/auth/token', grant)).status).toBe(200);
    expect(fresh).toHaveBeenCalledTimes(2);

    // A sender banned a moment ago gets no tokens either, though the bans held here know nothing of it.
    fresh.mockResolvedValue(
      new BanList([{ kind: 'ip', value: '192.0.2.1/32', reason: '', createdAt: 0, expiresAt: null }])
    );
    const refused = await call('/v1/auth/token', grant);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'banned' });
    // So does an account, which is answered as a grant no longer good, for Axe to log it out.
    fresh.mockResolvedValue(new BanList([{ kind: 'discord', value: '1', reason: '', createdAt: 0, expiresAt: null }]));
    const loggedOut = await call('/v1/auth/token', grant);
    expect(loggedOut.status).toBe(400);
    expect(await loggedOut.json()).toEqual({ error: 'invalid-grant' });
  });
});

describe('closing banned seats', () => {
  it('goes on to the other rooms when one cannot be reached, and says so in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const expel = vi
      .fn<ServerBackend['rooms']['expel']>()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce(undefined);
    const ban = vi.fn(async () => undefined);
    const backend = {
      addressOf: () => '192.0.2.1',
      limit: async () => true,
      lobby: { occupied: async () => ['a', 'b'] },
      rooms: { expel },
      moderation: { ...noModeration, ban },
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
      new Request(`${ADMIN}/api/bans`, {
        method: 'POST',
        headers: {
          'X-Admin-Request': '1',
          Cookie: await sessionCookieOf({ epoch: 0 }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ kind: 'discord', value: '42' }),
      })
    );

    expect(res.status).toBe(201);
    expect(ban).toHaveBeenCalledOnce();
    expect(expel).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Could not close the banned seats in a room:', expect.any(Error));
  });
});
