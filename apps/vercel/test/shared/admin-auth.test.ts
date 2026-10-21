import { afterEach, describe, expect, it, vi } from 'vitest';

import { STEP_UP_SECONDS } from '../../src/core/http/admin-session.js';
import { MAX_PASSKEYS } from '../../src/core/http/routes/admin-auth.js';
import type { AdminSessionResponse, PasskeySummary } from '../../src/core/http/routes/admin-auth.js';
import type { Activity } from '../../src/core/moderation/activity.js';
import { harness } from '../harness.js';
import { ADMIN, SESSION_COOKIE, callAdmin, sessionCookieOf, sessionSetBy } from './admin-helpers.js';
import type { AdminCall } from './admin-helpers.js';
import { fakeDiscord } from './auth-helpers.js';
import { freshIp, jsonOf, withinOneWindow } from './helpers.js';
import { SITE, assertionOf, registrationOf, softPasskey } from './passkey-helpers.js';
import type { SoftPasskey } from './passkey-helpers.js';
import { eventually } from './room-helpers.js';

// How an operator gets into the dashboard: Discord, then a passkey.

afterEach(() => {
  vi.restoreAllMocks();
});

let lastId = 0;
/** A Discord user id no other test uses, for an operator who starts with no passkeys. */
const freshOperator = () => `2${String(Date.now()).padStart(15, '0')}${String(++lastId).padStart(3, '0')}`;

/** The settings that make that operator one of those let in (and those who may reset). */
const operatorEnv = (id: string, reset = '') => ({
  ADMIN_DISCORD_IDS: `100000000000000001,${id}`,
  ADMIN_PASSKEY_RESET: reset,
});

/** Calls the dashboard's API as that operator (confirmed just now unless told otherwise), with the settings that let them in. */
const as = async (id: string, path: string, init: AdminCall = {}) =>
  callAdmin(path, {
    ...init,
    cookie: init.cookie === undefined ? await sessionCookieOf({ sub: id }) : init.cookie,
    env: { ...operatorEnv(id), ...init.env },
  });

/** Opens a page of the dashboard (as the browser does, with no Origin and none of the API's header). */
const open = (path: string, init: { cookie?: string; ip?: string; env?: Record<string, string | undefined> } = {}) => {
  const request = new Request(`${ADMIN}${path}`, {
    headers: { 'CF-Connecting-IP': init.ip ?? freshIp(), ...(init.cookie ? { Cookie: init.cookie } : {}) },
    redirect: 'manual',
  });
  return init.env ? harness.fetchWith(request, init.env) : harness.fetch(request);
};

/** Sets out for Discord: the state, and the cookie that ties the way back to this browser. */
const setOut = async (env?: Record<string, string | undefined>) => {
  const res = await open('/login', { env });
  const state = new URL(res.headers.get('Location') as string).searchParams.get('state') as string;
  const cookie = (res.headers.getSetCookie().find((set) => set.startsWith('__Host-axe-admin-login=')) as string).split(
    ';'
  )[0];
  return { res, state, cookie };
};

/** Comes back from Discord as that user, and returns where it was sent. */
const comeBack = async (
  user: { id: string; mfa_enabled?: boolean },
  init: { env?: Record<string, string | undefined>; ip?: string } = {}
) => {
  const { state, cookie } = await setOut(init.env);
  fakeDiscord({ username: 'op', global_name: 'Op', avatar: null, mfa_enabled: true, ...user });
  return open(`/login/callback?code=c&state=${state}`, { cookie, ip: init.ip, env: init.env });
};

const fragmentOf = (res: Response) => new URL(res.headers.get('Location') as string, ADMIN).hash;

const activity = async () => (await jsonOf<{ activity: Activity[] }>(await callAdmin('activity'))).activity;
const noted = (match: (entry: Activity) => boolean) =>
  eventually(activity, (entries) => entries.some(match)).then((entries) => entries.filter(match));

/** Registers a passkey for an operator whose session Discord alone let in. Returns the confirmed session. */
const register = async (id: string, passkey: SoftPasskey, cookie: string, name = 'ノートPC') => {
  const options = await jsonOf<{ token: string; options: { challenge: string } }>(
    await as(id, 'passkeys/options', { method: 'POST', cookie })
  );
  return as(id, 'passkeys', {
    method: 'POST',
    cookie,
    body: { token: options.token, name, credential: await registrationOf(passkey, options.options.challenge) },
  });
};

/** Confirms a session with the passkey. */
const confirmWith = async (id: string, passkey: SoftPasskey, cookie: string) => {
  const challenge = await jsonOf<{ token: string; options: { challenge: string } }>(
    await as(id, 'passkeys/challenge', { method: 'POST', cookie })
  );
  passkey.signCount++;
  return as(id, 'passkeys/verify', {
    method: 'POST',
    cookie,
    body: { token: challenge.token, credential: await assertionOf(passkey, challenge.options.challenge) },
  });
};

describe('getting into the dashboard through Discord', () => {
  it('sends the operator to Discord with a state tied to this browser', async () => {
    const { res, state, cookie } = await setOut();
    const location = new URL(res.headers.get('Location') as string);

    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('redirect_uri')).toBe(`${SITE.origin}/admin/login/callback`);
    expect(state).not.toBe('');
    expect(cookie).toMatch(/^__Host-axe-admin-login=.+/);
    expect(res.headers.getSetCookie().join()).toMatch(/HttpOnly.*Secure.*SameSite=Lax|SameSite=Lax.*Secure/);
  });

  it('lets a listed operator with two-step login on in, to confirm a passkey next', async () => {
    const id = freshOperator();
    const back = await comeBack({ id }, { env: operatorEnv(id) });
    const cookie = sessionSetBy(back) as string;
    const session = await jsonOf<AdminSessionResponse>(await as(id, 'session', { cookie }));

    expect(back.headers.get('Location')).toBe('/admin');
    expect(back.headers.getSetCookie().join()).toMatch(/__Host-axe-admin-login=;/);
    expect(session).toEqual({
      discordId: id,
      name: 'Op',
      stage: 'discord',
      passkeys: 0,
      mayRegister: true,
      verifiedAt: 0,
    });
    expect((await as(id, 'rooms', { cookie })).status).toBe(403);
  });

  it('turns away one who is not listed, or has no two-step login, and writes it down', async () => {
    const id = freshOperator();
    const stranger = await comeBack({ id });
    const noTwoStep = await comeBack({ id, mfa_enabled: false }, { env: operatorEnv(id) });

    expect(fragmentOf(stranger)).toBe('#denied=not-allowed');
    expect(sessionSetBy(stranger)).toBeNull();
    expect(fragmentOf(noTwoStep)).toBe('#denied=mfa-required');
    expect(await noted((entry) => entry.discordId === id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'admin', detail: 'denied not-allowed' }),
        expect.objectContaining({ kind: 'admin', detail: 'denied mfa-required' }),
      ])
    );
  });

  it('turns away a way back with no state of this browser, none from Discord, or a cancelled one', async () => {
    const { state } = await setOut();
    const otherBrowser = await setOut();
    fakeDiscord();
    const noState = await open('/login/callback?code=c');
    const wrongBrowser = await open(`/login/callback?code=c&state=${state}`, { cookie: otherBrowser.cookie });
    const cancelled = await setOut();
    const noCode = await open(`/login/callback?state=${cancelled.state}`, { cookie: cancelled.cookie });
    const failing = await setOut();
    fakeDiscord({ id: '1' }, 500);
    const discordDown = await open(`/login/callback?code=c&state=${failing.state}`, { cookie: failing.cookie });

    expect(fragmentOf(noState)).toBe('#denied=state');
    expect(fragmentOf(wrongBrowser)).toBe('#denied=state');
    expect(fragmentOf(noCode)).toBe('#denied=cancelled');
    expect(fragmentOf(discordDown)).toBe('#denied=discord');
  });

  it('says so when login is not set up, and counts the trips against the sender', async () => {
    const noLogin = { DISCORD_CLIENT_ID: undefined, DISCORD_CLIENT_SECRET: undefined, SESSION_SECRET: undefined };
    expect(fragmentOf(await open('/login', { env: noLogin }))).toBe('#denied=login-unavailable');
    expect(fragmentOf(await open('/login/callback?code=c', { env: noLogin }))).toBe('#denied=login-unavailable');

    const starts = await withinOneWindow(async (ip) => {
      const each: string[] = [];
      for (let i = 0; i < 6; i++) each.push(fragmentOf(await open('/login', { ip })));
      return each;
    });
    expect(starts.at(-1)).toBe('#denied=rate-limited');

    const backs = await withinOneWindow(async (ip) => {
      const each: string[] = [];
      for (let i = 0; i < 6; i++) each.push(fragmentOf(await comeBack({ id: '1' }, { ip })));
      return each;
    });
    expect(backs.at(-1)).toBe('#denied=rate-limited');
  });
});

describe('a local server over HTTP', () => {
  it('keeps its cookies without the __Host- prefix or Secure, which need HTTPS', async () => {
    const start = await harness.fetch(
      new Request('http://localhost/admin/login', { headers: { 'CF-Connecting-IP': freshIp() }, redirect: 'manual' })
    );
    const session = await harness.fetch(
      new Request('http://localhost/admin/api/session', {
        headers: {
          'X-Admin-Request': '1',
          'CF-Connecting-IP': freshIp(),
          Cookie: (await sessionCookieOf()).replace('__Host-', ''),
        },
      })
    );

    expect(start.headers.getSetCookie().join()).toMatch(/^axe-admin-login=/);
    expect(start.headers.getSetCookie().join()).not.toMatch(/Secure/);
    expect(session.status).toBe(200);
    expect(session.headers.getSetCookie().join()).toMatch(/^axe-admin=/);
  });
});

describe('passkeys', () => {
  it('registers an operator’s first passkey, which confirms the session, and confirms later sessions', async () => {
    const id = freshOperator();
    const passkey = await softPasskey();
    const first = await sessionCookieOf({ stage: 'discord', sub: id });
    const options = await jsonOf<{
      options: { rp: { id: string }; user: { id: string }; excludeCredentials: unknown[] };
    }>(await as(id, 'passkeys/options', { method: 'POST', cookie: first }));
    const made = await register(id, passkey, first);
    const confirmed = sessionSetBy(made) as string;

    expect(options.options.rp.id).toBe(SITE.rpId);
    expect(options.options.excludeCredentials).toEqual([]);
    expect(made.status).toBe(201);
    expect((await jsonOf<{ passkey: PasskeySummary }>(made)).passkey).toEqual({
      id: passkey.id,
      name: 'ノートPC',
      algorithm: -7,
      createdAt: expect.any(Number),
      usedAt: expect.any(Number),
    });
    expect((await as(id, 'rooms', { cookie: confirmed })).status).toBe(200);
    expect(await noted((entry) => entry.discordId === id && entry.detail === 'login')).toHaveLength(1);

    const later = await sessionCookieOf({ stage: 'discord', sub: id });
    const state = await jsonOf<AdminSessionResponse>(await as(id, 'session', { cookie: later }));
    expect(state).toMatchObject({ stage: 'discord', passkeys: 1, mayRegister: false });
    expect((await as(id, 'passkeys/options', { method: 'POST', cookie: later })).status).toBe(403);
    const unasked = await as(id, 'passkeys', {
      method: 'POST',
      cookie: later,
      body: { token: 'x', name: 'x', credential: await registrationOf(await softPasskey(), 'x') },
    });
    expect(unasked.status).toBe(403);
    expect(await unasked.json()).toEqual({ error: 'passkey-required' });
    const verified = await confirmWith(id, passkey, later);
    expect(verified.status).toBe(204);
    expect((await as(id, 'rooms', { cookie: sessionSetBy(verified) as string })).status).toBe(200);
  });

  it('takes an RS256 passkey, and gives an unnamed one a name', async () => {
    const id = freshOperator();
    const passkey = await softPasskey(-257);
    const made = await register(id, passkey, await sessionCookieOf({ stage: 'discord', sub: id }), '  ');

    expect((await jsonOf<{ passkey: PasskeySummary }>(made)).passkey).toMatchObject({
      name: 'パスキー',
      algorithm: -257,
    });
    expect((await confirmWith(id, passkey, await sessionCookieOf({ stage: 'discord', sub: id }))).status).toBe(204);
  });

  it('takes each challenge once, only in the session and for the purpose it was given', async () => {
    const id = freshOperator();
    const passkey = await softPasskey();
    await register(id, passkey, await sessionCookieOf({ stage: 'discord', sub: id }));
    const cookie = await sessionCookieOf({ stage: 'discord', sub: id });
    const challenge = await jsonOf<{ token: string; options: { challenge: string } }>(
      await as(id, 'passkeys/challenge', { method: 'POST', cookie })
    );
    passkey.signCount++;
    const body = { token: challenge.token, credential: await assertionOf(passkey, challenge.options.challenge) };

    const otherSession = await as(id, 'passkeys/verify', {
      method: 'POST',
      cookie: await sessionCookieOf({ stage: 'discord', sub: id }),
      body,
    });
    const asRegistration = await as(id, 'passkeys', {
      method: 'POST',
      cookie: await sessionCookieOf({ sub: id }),
      body: {
        token: challenge.token,
        name: 'x',
        credential: await registrationOf(passkey, challenge.options.challenge),
      },
    });
    const once = await as(id, 'passkeys/verify', { method: 'POST', cookie, body });
    const twice = await as(id, 'passkeys/verify', { method: 'POST', cookie, body });

    expect(otherSession.status).toBe(400);
    expect(await otherSession.json()).toEqual({ error: 'invalid-challenge' });
    expect(asRegistration.status).toBe(400);
    expect(once.status).toBe(204);
    expect(twice.status).toBe(400);
  });

  it('turns away a signature by another key, a passkey it does not know, and one made wrong', async () => {
    const id = freshOperator();
    const passkey = await softPasskey();
    await register(id, passkey, await sessionCookieOf({ stage: 'discord', sub: id }));
    const tryWith = async (credential: (challenge: string) => Promise<object>) => {
      const cookie = await sessionCookieOf({ stage: 'discord', sub: id });
      const challenge = await jsonOf<{ token: string; options: { challenge: string } }>(
        await as(id, 'passkeys/challenge', { method: 'POST', cookie })
      );
      return as(id, 'passkeys/verify', {
        method: 'POST',
        cookie,
        body: { token: challenge.token, credential: await credential(challenge.options.challenge) },
      });
    };
    const stranger = await softPasskey();

    const forged = await tryWith(async (challenge) => ({
      ...(await assertionOf(stranger, challenge)),
      id: passkey.id,
    }));
    const unknown = await tryWith((challenge) => assertionOf(stranger, challenge));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'passkey-refused' });
    expect(unknown.status).toBe(401);
    expect(
      await noted((entry) => entry.discordId === id && entry.detail?.startsWith('denied passkey') === true)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: 'denied passkey signature' }),
        expect.objectContaining({ detail: 'denied passkey credential' }),
      ])
    );

    const another = freshOperator();
    await register(another, await softPasskey(), await sessionCookieOf({ stage: 'discord', sub: another }));
    const anotherCookie = await sessionCookieOf({ stage: 'discord', sub: another });
    const anotherChallenge = await jsonOf<{ token: string; options: { challenge: string } }>(
      await as(another, 'passkeys/challenge', { method: 'POST', cookie: anotherCookie })
    );
    const notTheirs = await as(another, 'passkeys/verify', {
      method: 'POST',
      cookie: anotherCookie,
      body: {
        token: anotherChallenge.token,
        credential: await assertionOf(passkey, anotherChallenge.options.challenge),
      },
    });
    expect(notTheirs.status).toBe(401);

    const other = freshOperator();
    const cookie = await sessionCookieOf({ stage: 'discord', sub: other });
    const options = await jsonOf<{ token: string }>(await as(other, 'passkeys/options', { method: 'POST', cookie }));
    const badlyMade = await as(other, 'passkeys', {
      method: 'POST',
      cookie,
      body: { token: options.token, name: 'x', credential: await registrationOf(passkey, 'another challenge') },
    });
    expect(badlyMade.status).toBe(400);
    expect(await badlyMade.json()).toEqual({ error: 'passkey-refused' });
  });

  it('turns away a body in the wrong form, and counts confirmations against the sender', async () => {
    const id = freshOperator();
    const cookie = await sessionCookieOf({ stage: 'discord', sub: id });
    const shaped = { id: 'a', clientDataJSON: 'a', authenticatorData: 'a', signature: 'a' };

    expect((await as(id, 'passkeys', { method: 'POST', cookie, body: { token: 1 } })).status).toBe(400);
    expect((await as(id, 'passkeys', { method: 'POST', cookie, body: '{' })).status).toBe(400);
    expect((await as(id, 'passkeys/verify', { method: 'POST', cookie, body: '{' })).status).toBe(400);
    const badToken = await as(id, 'passkeys/verify', {
      method: 'POST',
      cookie,
      body: { token: 'x', credential: shaped },
    });
    expect(await badToken.json()).toEqual({ error: 'invalid-challenge' });
    const statuses = await withinOneWindow(async (ip) => {
      const each: number[] = [];
      for (let i = 0; i < 6; i++)
        each.push((await as(id, 'passkeys/verify', { method: 'POST', cookie, ip, body: {} })).status);
      return each;
    });
    expect(statuses.at(-1)).toBe(429);
    expect((await as(id, 'passkeys/challenge', { method: 'POST', cookie })).status).toBe(409);
  });

  it('adds more passkeys only after a recent confirmation, never the same one twice, and up to the limit', async () => {
    const id = freshOperator();
    const first = await softPasskey();
    await register(id, first, await sessionCookieOf({ stage: 'discord', sub: id }));
    const now = Math.floor(Date.now() / 1000);

    const stale = await as(id, 'passkeys/options', {
      method: 'POST',
      cookie: await sessionCookieOf({ sub: id, verified: now - 3600 }),
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: 'reauth-required' });
    const again = await register(id, first, await sessionCookieOf({ sub: id }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'passkey-exists' });

    for (let i = 1; i < MAX_PASSKEYS; i++) {
      expect((await register(id, await softPasskey(), await sessionCookieOf({ sub: id }), `端末${i}`)).status).toBe(
        201
      );
    }
    const tooMany = await as(id, 'passkeys/options', { method: 'POST', cookie: await sessionCookieOf({ sub: id }) });
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toEqual({ error: 'too-many-passkeys' });
  });

  it('lets one in ADMIN_PASSKEY_RESET register without the passkey they lost', async () => {
    const id = freshOperator();
    await register(id, await softPasskey(), await sessionCookieOf({ stage: 'discord', sub: id }));
    const cookie = await sessionCookieOf({ stage: 'discord', sub: id });

    const res = await callAdmin('session', { cookie, env: operatorEnv(id, id) });
    expect((await jsonOf<AdminSessionResponse>(res)).mayRegister).toBe(true);
  });
});

describe('managing passkeys and sessions', () => {
  it('lists the operator’s passkeys without their keys, and removes all but the last after a recent confirmation', async () => {
    const id = freshOperator();
    const one = await softPasskey();
    const two = await softPasskey();
    await register(id, one, await sessionCookieOf({ stage: 'discord', sub: id }), '一');
    await register(id, two, await sessionCookieOf({ sub: id }), '二');
    const now = Math.floor(Date.now() / 1000);

    const listed = await jsonOf<{ passkeys: PasskeySummary[] }>(await as(id, 'passkeys'));
    expect(listed.passkeys.map((passkey) => passkey.name).sort()).toEqual(['一', '二']);
    expect(await jsonOf<AdminSessionResponse>(await as(id, 'session'))).toMatchObject({
      stage: 'passkey',
      mayRegister: false,
    });
    expect(Object.keys(listed.passkeys[0])).not.toContain('publicKey');
    expect(
      (
        await as(id, `passkeys/${one.id}`, {
          method: 'DELETE',
          cookie: await sessionCookieOf({ sub: id, verified: now - 3600 }),
        })
      ).status
    ).toBe(403);
    expect((await as(id, 'passkeys/nothing', { method: 'DELETE' })).status).toBe(404);
    expect((await as(id, `passkeys/${one.id}`, { method: 'DELETE' })).status).toBe(204);
    const last = await as(id, `passkeys/${two.id}`, { method: 'DELETE' });
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: 'last-passkey' });
  });

  it('asks for a recent confirmation before deleting a room', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await callAdmin(`rooms/${'f'.repeat(32)}`, {
      method: 'DELETE',
      cookie: await sessionCookieOf({ verified: now - STEP_UP_SECONDS - 1 }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'reauth-required' });
  });

  it('logs out this session, and ends every session at once', async () => {
    const out = await callAdmin('logout', { method: 'POST', cookie: null });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().join()).toMatch(/__Host-axe-admin=;/);

    // A call still on its way as the operator logs out answers with the cookie set again. The
    // session does not come back with it.
    const left = await sessionCookieOf();
    expect((await callAdmin('rooms', { cookie: left })).status).toBe(200);
    expect((await callAdmin('logout', { method: 'POST', cookie: left })).status).toBe(204);
    expect((await callAdmin('rooms', { cookie: left })).status).toBe(401);

    const before = await harness.adminEpoch();
    const other = await sessionCookieOf();
    const ended = await callAdmin('sessions/revoke', { method: 'POST' });

    expect(ended.status).toBe(204);
    expect(await harness.adminEpoch()).toBe(before + 1);
    expect(sessionSetBy(ended)).toBeNull();
    expect((await callAdmin('rooms', { cookie: other })).status).toBe(401);
    expect(SESSION_COOKIE).toBe('__Host-axe-admin');
  });
});
