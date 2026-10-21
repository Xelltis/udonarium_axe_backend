import { afterEach, describe, expect, it, vi } from 'vitest';

import { notingLimits } from '../../src/core/http/moderation.js';
import { formatRange, inRange, parseAddress, parseRange } from '../../src/core/moderation/address.js';
import type { AddressRange } from '../../src/core/moderation/address.js';
import {
  NOTE_ONCE_MS,
  isOperatorStep,
  moderationOf,
  noModeration,
  noteOnce,
} from '../../src/core/moderation/activity.js';
import {
  ADMIN_DENIED,
  ADMIN_LOGIN,
  ALERT_MS,
  STORAGE_ALERT_MS,
  alertOf,
  gbOf,
  webhookAlerts,
} from '../../src/core/moderation/alerts.js';
import type { AlertKind } from '../../src/core/moderation/alerts.js';
import type { Activity, ModerationStore } from '../../src/core/moderation/activity.js';
import {
  BanList,
  NO_PAUSE,
  NO_TIGHTEN,
  banCache,
  banValueOf,
  discordIdOf,
  seatBarredBy,
} from '../../src/core/moderation/bans.js';
import type { Ban, ModerationState } from '../../src/core/moderation/bans.js';

/** What the store gives: these bans, and nothing stopped. */
const stateOf = (bans: Ban[]): ModerationState => ({ bans, pause: NO_PAUSE, tighten: NO_TIGHTEN, blocked: [] });
import type { Seat } from '../../src/core/rooms/host.js';

// The pieces the operator's bans are made of. They touch no room server.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const range = (text: string) => parseRange(text) as AddressRange;

const banOf = (kind: Ban['kind'], value: string, expiresAt: number | null = null): Ban => ({
  kind,
  value,
  reason: '',
  createdAt: 0,
  expiresAt,
});

describe('parseAddress', () => {
  it('reads IPv4 and IPv6, and takes IPv4 written inside IPv6 as IPv4', () => {
    expect(parseAddress('192.0.2.1')).toEqual({ version: 4, bits: 0xc0000201n });
    expect(parseAddress(' 2001:db8::1 ')).toEqual({ version: 6, bits: 0x20010db8000000000000000000000001n });
    expect(parseAddress('::ffff:192.0.2.1')).toEqual({ version: 4, bits: 0xc0000201n });
    expect(parseAddress('::FFFF:c000:0201')).toEqual({ version: 4, bits: 0xc0000201n });
    expect(parseAddress('64:ff9b::192.0.2.1')).toEqual({ version: 6, bits: 0x0064ff9b0000000000000000c0000201n });
    expect(parseAddress('1:2:3:4:5:6:7:8')).toEqual({ version: 6, bits: 0x00010002000300040005000600070008n });
    expect(parseAddress('::')).toEqual({ version: 6, bits: 0n });
  });

  it('leaves out the zone of a link-local address', () => {
    expect(parseAddress('fe80::1%eth0')).toEqual(parseAddress('fe80::1'));
  });

  it.each([
    'unknown',
    '',
    '192.0.2',
    '192.0.2.1.5',
    '192.0.2.256',
    '192.0.2.-1',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    '1:2:3:4::5:6:7:8',
    ':1:2:3:4:5:6:7',
    '12345::',
    'g::',
    '::ffff:192.0.2',
  ])('turns away %j', (text) => {
    expect(parseAddress(text)).toBeNull();
  });
});

describe('parseRange and formatRange', () => {
  it.each([
    ['192.0.2.5', '192.0.2.5/32'],
    ['192.0.2.5/24', '192.0.2.0/24'],
    ['10.1.2.3/8', '10.0.0.0/8'],
    ['::ffff:192.0.2.5', '192.0.2.5/32'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:3:4:5:6/128', '2001:db8:1:2:3:4:5:6/128'],
    ['2001:DB8::/32', '2001:db8::/32'],
    ['2001:db8:0:0:1:0:0:1/128', '2001:db8::1:0:0:1/128'],
    ['2001:0:0:1::1/128', '2001:0:0:1::1/128'],
    ['1:0:2:0:3:0:4:0/128', '1:0:2:0:3:0:4:0/128'],
    ['ffff::/16', 'ffff::/16'],
    ['::1/128', '::1/128'],
    ['1::/128', '1::/128'],
  ])('writes %j the one way it is kept, as %j', (text, kept) => {
    expect(formatRange(range(text))).toBe(kept);
  });

  it.each([
    'nope',
    '192.0.2.0/7',
    '192.0.2.0/33',
    '2001:db8::/15',
    '2001:db8::/129',
    '192.0.2.0/',
    '192.0.2.0/2x',
    '192.0.2.0/1234',
    '192.0.2.0/24/8',
  ])('turns away %j', (text) => {
    expect(parseRange(text)).toBeNull();
  });
});

describe('inRange', () => {
  it('finds the addresses in a range, of the same kind only', () => {
    expect(inRange(range('192.0.2.0/24'), '192.0.2.200')).toBe(true);
    expect(inRange(range('192.0.2.0/24'), '::ffff:192.0.2.200')).toBe(true);
    expect(inRange(range('192.0.2.0/24'), '192.0.3.1')).toBe(false);
    expect(inRange(range('2001:db8::/64'), '2001:db8::abcd')).toBe(true);
    expect(inRange(range('2001:db8::/64'), '2001:db8:0:1::1')).toBe(false);
    expect(inRange(range('0.0.0.0/8'), '::')).toBe(false);
    expect(inRange(range('192.0.2.0/24'), 'unknown')).toBe(false);
  });
});

describe('banValueOf and discordIdOf', () => {
  it('keeps a Discord id as it is and a range in its one form, and turns away anything else', () => {
    expect(banValueOf('discord', ' 123456789012345678 ')).toBe('123456789012345678');
    expect(banValueOf('discord', 'kai')).toBeNull();
    expect(banValueOf('ip', '203.0.113.9/24')).toBe('203.0.113.0/24');
    expect(banValueOf('ip', '203.0.113')).toBeNull();
  });

  it('takes the Discord user id out of a Discord account only', () => {
    expect(discordIdOf('discord:42')).toBe('42');
    expect(discordIdOf('github:42')).toBeNull();
    expect(discordIdOf(undefined)).toBeNull();
  });
});

describe('BanList', () => {
  const now = 1_000_000;
  const list = new BanList([
    banOf('ip', '192.0.2.0/24'),
    banOf('ip', '198.51.100.7/32', now - 1),
    banOf('ip', 'written by hand'),
    banOf('discord', '42'),
    banOf('discord', '43', now + 1),
    banOf('discord', '44', now),
  ]);

  it('finds the ban on an address while it is in force', () => {
    expect(list.addressBan('192.0.2.9', now)?.value).toBe('192.0.2.0/24');
    expect(list.addressBan('198.51.100.7', now)).toBeNull();
    expect(list.addressBan('203.0.113.1', now)).toBeNull();
  });

  it('finds the ban on an account while it is in force', () => {
    expect(list.accountBan('discord:42', now)?.value).toBe('42');
    expect(list.accountBan('discord:43', now)?.value).toBe('43');
    expect(list.accountBan('discord:44', now)).toBeNull();
    expect(list.accountBan('discord:45', now)).toBeNull();
    expect(list.accountBan(undefined, now)).toBeNull();
  });

  it('goes by the clock when no time is given', () => {
    expect(new BanList([banOf('discord', '42', Date.now() + 60_000)]).accountBan('discord:42')).not.toBeNull();
    expect(new BanList([banOf('ip', '192.0.2.1')]).addressBan('192.0.2.1')).not.toBeNull();
  });
});

describe('seatBarredBy', () => {
  const seat = (extra: Partial<Seat>): Seat => ({
    peerId: 'p',
    userId: 'u',
    roomKey: 'r',
    role: 'pl',
    account: false,
    joinedAt: 0,
    activeAt: 0,
    ...extra,
  });

  it('covers a seat by its address or by its account', () => {
    const byAddress = seatBarredBy(banOf('ip', '192.0.2.0/24'));
    const byAccount = seatBarredBy(banOf('discord', '42'));

    expect(byAddress(seat({ address: '192.0.2.3' }))).toBe(true);
    expect(byAddress(seat({ address: '192.0.3.3' }))).toBe(false);
    expect(byAddress(seat({}))).toBe(false);
    expect(byAccount(seat({ account: true, accountKey: 'discord:42' }))).toBe(true);
    expect(byAccount(seat({ account: true, accountKey: 'discord:43', address: '192.0.2.3' }))).toBe(false);
  });
});

describe('banCache', () => {
  /** A read that resolves when the test says so. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };

  it('reads again only once the bans it holds have grown old', async () => {
    vi.useFakeTimers({ now: 0 });
    const load = vi.fn(async () => stateOf([banOf('discord', '42')]));
    const cache = banCache(load, 1000);

    expect((await cache.current()).accountBan('discord:42')).not.toBeNull();
    await cache.current();
    expect(load).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1000);
    await cache.current();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads again at once after forgetting, and does not keep what a read begun before brought', async () => {
    const first = deferred<ModerationState>();
    const load = vi
      .fn<() => Promise<ModerationState>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(stateOf([banOf('discord', 'new')]));
    const cache = banCache(load);

    const stale = cache.current();
    cache.forget();
    const fresh = await cache.current();
    first.resolve(stateOf([banOf('discord', 'old')]));

    expect((await stale).accountBan('discord:old')).not.toBeNull();
    expect(fresh.accountBan('discord:new')).not.toBeNull();
    expect((await cache.current()).accountBan('discord:new')).not.toBeNull();
    expect((await cache.current()).accountBan('discord:old')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('goes on with the bans it held when they cannot be read, and tries again only once they grow old', async () => {
    vi.useFakeTimers({ now: 0 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi
      .fn<() => Promise<ModerationState>>()
      .mockResolvedValueOnce(stateOf([banOf('discord', '42')]))
      .mockRejectedValue(new Error('down'));
    const cache = banCache(load, 1000);
    await cache.current();
    vi.setSystemTime(1000);

    expect((await cache.current()).accountBan('discord:42')).not.toBeNull();
    await cache.current();

    expect(load).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Could not read the bans:', expect.any(Error));
  });

  it('reads now each time it is asked for the bans as they stand, and holds what it read', async () => {
    vi.useFakeTimers({ now: 0 });
    const load = vi
      .fn<() => Promise<ModerationState>>()
      .mockResolvedValueOnce(stateOf([banOf('discord', '1')]))
      .mockResolvedValueOnce(stateOf([banOf('discord', '2')]));
    const cache = banCache(load, 1000);

    expect((await cache.fresh()).accountBan('discord:1')).not.toBeNull();
    expect((await cache.fresh()).accountBan('discord:2')).not.toBeNull();

    expect((await cache.current()).accountBan('discord:2')).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not hold what a read brings once a read begun after it has come back', async () => {
    const first = deferred<ModerationState>();
    const load = vi
      .fn<() => Promise<ModerationState>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(stateOf([banOf('discord', 'new')]));
    const cache = banCache(load);

    const slow = cache.fresh();
    expect((await cache.fresh()).accountBan('discord:new')).not.toBeNull();
    first.resolve(stateOf([banOf('discord', 'old')]));

    expect((await slow).accountBan('discord:old')).not.toBeNull();
    expect((await cache.current()).accountBan('discord:new')).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('gives the bans it read last when they cannot be read now', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = deferred<ModerationState>();
    const load = vi
      .fn<() => Promise<ModerationState>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(stateOf([banOf('discord', '42')]))
      .mockRejectedValue(new Error('down'));
    const cache = banCache(load);

    const failingLate = cache.fresh();
    await cache.fresh();
    first.reject(new Error('down'));

    expect((await failingLate).accountBan('discord:42')).not.toBeNull();
    expect((await cache.fresh()).accountBan('discord:42')).not.toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('holds what is stopped and what is barred along with the bans, and nothing before the first read', async () => {
    const pause = { rooms: true, uploads: false, logins: true, since: 5 };
    const tighten = { upload: 4, read: 1, room: 2, auth: 1, since: 6 } as const;
    const cache = banCache(async () => ({ bans: [], pause, tighten, blocked: ['a'.repeat(64)] }));

    expect(new BanList([]).pause).toEqual(NO_PAUSE);
    expect(new BanList([]).tighten).toEqual(NO_TIGHTEN);
    expect(new BanList([]).blocked.size).toBe(0);
    expect((await cache.current()).pause).toEqual(pause);
    expect((await cache.current()).tighten).toEqual(tighten);
    expect((await cache.current()).blocked.has('a'.repeat(64))).toBe(true);
  });

  it('does not count a failed read begun before forgetting as a read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = deferred<ModerationState>();
    const load = vi
      .fn<() => Promise<ModerationState>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(stateOf([banOf('discord', '42')]));
    const cache = banCache(load);

    const failing = cache.current();
    cache.forget();
    first.reject(new Error('down'));

    expect((await failing).accountBan('discord:42')).toBeNull();
    expect((await cache.current()).accountBan('discord:42')).not.toBeNull();
  });
});

describe('the operators’ own steps', () => {
  it('are what an operator did, not someone turned away from the dashboard', () => {
    const at = { at: 1, address: '192.0.2.1' };

    expect(isOperatorStep({ ...at, kind: 'admin', detail: 'ban ip 192.0.2.1/32' })).toBe(true);
    expect(isOperatorStep({ ...at, kind: 'admin' })).toBe(true);
    expect(isOperatorStep({ ...at, kind: 'admin', detail: `${ADMIN_DENIED} not-allowed` })).toBe(false);
    expect(isOperatorStep({ ...at, kind: 'login' })).toBe(false);
  });
});

describe('moderationOf', () => {
  const entry: Activity = { at: 1, kind: 'login', address: '192.0.2.1' };
  const storeOf = (overrides: Partial<ModerationStore> = {}): ModerationStore => ({
    bans: async () => [banOf('discord', '42')],
    state: async () => stateOf([banOf('discord', '42')]),
    setPause: async () => undefined,
    setBlocked: async () => undefined,
    setTighten: async () => undefined,
    putBan: async () => undefined,
    deleteBan: async () => true,
    note: async () => undefined,
    activity: async () => [entry],
    claimAlert: async () => true,
    storageUsage: async () => null,
    putStorageUsage: async () => undefined,
    putReport: async () => true,
    reports: async () => [],
    setReportStatus: async () => null,
    ...noModeration.admin,
    ...overrides,
  });

  it('forgets the bans this instance holds once it changes them', async () => {
    const cache = {
      current: vi.fn(async () => new BanList([])),
      fresh: vi.fn(async () => new BanList([])),
      forget: vi.fn(),
    };
    const moderation = moderationOf(storeOf(), cache, () => undefined);

    await moderation.ban(banOf('discord', '42'));
    expect(await moderation.unban('discord', '42')).toBe(true);
    await moderation.setPause(NO_PAUSE);
    await moderation.setTighten(NO_TIGHTEN);
    await moderation.current();
    await moderation.fresh();

    expect(cache.forget).toHaveBeenCalledTimes(4);
    expect(cache.current).toHaveBeenCalledTimes(1);
    expect(cache.fresh).toHaveBeenCalledTimes(1);
    expect(await moderation.bans()).toEqual([banOf('discord', '42')]);
    expect(await moderation.activity()).toEqual([entry]);
  });

  it('writes down after the response, and only logs a write that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deferredWork: Promise<unknown>[] = [];
    const moderation = moderationOf(
      storeOf({ note: async () => Promise.reject(new Error('full')) }),
      banCache(async () => stateOf([])),
      (work) => deferredWork.push(work)
    );

    moderation.note(entry);
    await Promise.all(deferredWork);

    expect(error).toHaveBeenCalledWith('Could not write down what happened:', expect.any(Error));
  });

  it('sends an alert for what calls for one, after the response, and only logs one that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deferredWork: Promise<unknown>[] = [];
    const alert = vi.fn(async (kind: AlertKind) => {
      if (kind === 'refused') throw new Error('down');
    });
    const moderation = moderationOf(
      storeOf(),
      banCache(async () => stateOf([])),
      (work) => deferredWork.push(work),
      alert
    );

    moderation.note({ at: 1, kind: 'login', address: '192.0.2.1' });
    moderation.note({ at: 1, kind: 'limited', address: '192.0.2.1', detail: 'read' });
    moderation.note({ at: 1, kind: 'refused', address: '192.0.2.1' });
    await Promise.all(deferredWork);

    expect(alert.mock.calls.map(([kind]) => kind)).toEqual(['limited', 'refused']);
    expect(error).toHaveBeenCalledWith('Could not send the alert:', expect.any(Error));
  });

  it('keeps a report, and tells of it after the response where alerts are sent, logging an alert that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const kept = {
      id: 'r',
      at: 1,
      roomKey: '0'.repeat(32),
      target: 'room',
      assetId: null,
      reason: 'x',
      reporter: { address: '192.0.2.1', discordId: null, userId: 'u', role: 'pl' },
      status: 'open',
      handledAt: null,
      handledBy: null,
    } as const;
    const putReport = vi.fn(async () => true);
    const store = storeOf({ putReport, reports: async () => [kept], setReportStatus: async () => kept });
    const deferredWork: Promise<unknown>[] = [];
    const alert = vi.fn(async () => {
      throw new Error('down');
    });
    const withAlerts = moderationOf(
      store,
      banCache(async () => stateOf([])),
      (work) => deferredWork.push(work),
      alert
    );
    const without = moderationOf(
      store,
      banCache(async () => stateOf([])),
      () => undefined
    );

    expect(await withAlerts.report(kept)).toBe(true);
    await without.report(kept);
    // One its reporter has made too many of: not kept, and nobody is told.
    putReport.mockResolvedValueOnce(false);
    expect(await withAlerts.report(kept)).toBe(false);
    await Promise.all(deferredWork);

    expect(putReport).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledExactlyOnceWith('report', {});
    expect(error).toHaveBeenCalledWith('Could not send the alert:', expect.any(Error));
    expect(await withAlerts.reports()).toEqual([kept]);
    expect(await withAlerts.setReportStatus('r', 'done', '1', 2)).toEqual(kept);
    expect(await noModeration.report(kept)).toBe(true);
    expect(await noModeration.reports()).toEqual([]);
    expect(await noModeration.setReportStatus('r', 'done', '1', 2)).toBeNull();
  });

  it('keeps the store’s size, and tells of it only where alerts are sent', async () => {
    const usage = { bytes: 5, assets: 1, at: 2, complete: true };
    const putStorageUsage = vi.fn(async () => undefined);
    const store = storeOf({ storageUsage: async () => usage, putStorageUsage });
    const alert = vi.fn(async () => undefined);
    const withAlerts = moderationOf(
      store,
      banCache(async () => stateOf([])),
      () => undefined,
      alert
    );
    const without = moderationOf(
      store,
      banCache(async () => stateOf([])),
      () => undefined
    );

    expect(await withAlerts.storageUsage()).toEqual(usage);
    await withAlerts.putStorageUsage(usage);
    await withAlerts.alertStorage(usage, 4);
    await without.alertStorage(usage, 4);

    expect(putStorageUsage).toHaveBeenCalledWith(usage);
    expect(alert.mock.calls).toEqual([['storage', { usage, limitBytes: 4 }]]);
    expect(await noModeration.storageUsage()).toBeNull();
    await noModeration.setTighten(NO_TIGHTEN);
    await noModeration.putStorageUsage(usage);
    await noModeration.alertStorage(usage, 4);
  });
});

describe('alerts', () => {
  const at = { at: 1, address: '192.0.2.1' };

  it('are called for by limits, banned ones coming back, and logins to the dashboard and refusals there', () => {
    expect(alertOf({ ...at, kind: 'limited', detail: 'read' })).toBe('limited');
    expect(alertOf({ ...at, kind: 'refused' })).toBe('refused');
    expect(alertOf({ ...at, kind: 'admin', detail: `${ADMIN_DENIED} not-allowed` })).toBe('admin-denied');
    expect(alertOf({ ...at, kind: 'admin', detail: ADMIN_LOGIN })).toBe('admin-login');
    expect(alertOf({ ...at, kind: 'admin', detail: 'ban ip 192.0.2.1/32' })).toBeNull();
    expect(alertOf({ ...at, kind: 'admin' })).toBeNull();
    expect(alertOf({ ...at, kind: 'login' })).toBeNull();
  });

  it('go to the webhook only when the store lets this instance send them, and name nobody', async () => {
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const claim = vi
      .fn<(kind: AlertKind, ms: number) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    // Two instances: the store lets one of them send it.
    const send = webhookAlerts('https://discord.example/api/webhooks/1/token', claim);
    const other = webhookAlerts('https://discord.example/api/webhooks/1/token', claim);

    await send('limited', {});
    await other('limited', {});

    expect(claim).toHaveBeenCalledWith('limited', ALERT_MS);
    expect(sent).toHaveBeenCalledOnce();
    const [url, init] = sent.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.example/api/webhooks/1/token');
    const body = JSON.parse(init.body as string) as { content: string; allowed_mentions: unknown };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain('回数の上限');
    expect(body.content).not.toContain('192.0.2.1');
  });

  it('ask the store about one kind once in a while on each instance, however often it happens', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const claim = vi.fn<(kind: AlertKind, ms: number) => Promise<boolean>>(async () => false);
    const send = webhookAlerts('https://discord.example/x', claim);

    for (let i = 0; i < 5; i++) await send('refused', {});
    await send('limited', {});
    expect(claim.mock.calls.map(([kind]) => kind)).toEqual(['refused', 'limited']);

    vi.advanceTimersByTime(ALERT_MS);
    await send('refused', {});
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it('say who got into the dashboard every time, and what else happened once in a while', async () => {
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const claim = vi.fn<(kind: AlertKind, ms: number) => Promise<boolean>>(async () => true);
    const send = webhookAlerts('https://discord.example/x', claim);

    await send('admin-login', { name: 'Op' });
    await send('admin-login', {});
    await send('refused', {});
    await send('admin-denied', {});

    const contents = sent.mock.calls.map(
      ([, init]) => (JSON.parse((init as RequestInit).body as string) as { content: string }).content
    );
    expect(contents[0]).toContain('Opがログインしました');
    expect(contents[1]).toContain('運営する人がログインしました');
    expect(contents[2]).toContain('BANした');
    expect(contents[3]).toContain('断られた');
    await send('report', {});
    expect(JSON.parse((sent.mock.calls[4][1] as RequestInit).body as string).content).toContain('通報がありました');
    expect(claim.mock.calls.map(([kind]) => kind)).toEqual(['refused', 'admin-denied', 'report']);
  });

  it('say how full the store is, past what amount, once a day at most', async () => {
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const claim = vi.fn<(kind: AlertKind, ms: number) => Promise<boolean>>(async () => true);
    const usage = { bytes: 12_340_000_000, assets: 321, at: 1, complete: true };

    await webhookAlerts('https://discord.example/x', claim)('storage', { usage, limitBytes: 10_000_000_000 });

    expect(claim).toHaveBeenCalledWith('storage', STORAGE_ALERT_MS);
    const { content } = JSON.parse((sent.mock.calls[0][1] as RequestInit).body as string) as { content: string };
    expect(content).toContain('知らせる量（10.00 GB）');
    expect(content).toContain('いまは12.34 GB（321件）');
    expect(gbOf(500_000_000)).toBe('0.50 GB');
  });

  it('throw when the webhook does not take them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    await expect(webhookAlerts('https://discord.example/x', async () => true)('refused', {})).rejects.toThrow(
      'The webhook answered 404'
    );
  });
});

describe('noModeration', () => {
  it('has no bans and keeps nothing', async () => {
    noModeration.note({ at: 1, kind: 'login', address: '192.0.2.1' });
    await noModeration.ban(banOf('ip', '192.0.2.1/32'));

    expect((await noModeration.current()).addressBan('192.0.2.1')).toBeNull();
    expect((await noModeration.fresh()).addressBan('192.0.2.1')).toBeNull();
    expect(await noModeration.bans()).toEqual([]);
    expect(await noModeration.unban('ip', '192.0.2.1/32')).toBe(false);
    await noModeration.setPause(NO_PAUSE);
    expect(await noModeration.activity()).toEqual([]);
    const { admin } = noModeration;
    await admin.putPasskey({} as never);
    expect(await admin.passkeysOf('1')).toEqual([]);
    expect(await admin.passkey('a')).toBeNull();
    expect(await admin.deletePasskey('a')).toBe(false);
    expect(await admin.adminEpoch()).toBe(0);
    expect(await admin.raiseAdminEpoch()).toBe(0);
    expect(await admin.takeChallenge('c', 1)).toBe(false);
    await admin.endSession('s', 1);
    expect(await admin.sessionEnded('s')).toBe(false);
  });
});

describe('noteOnce', () => {
  it('says yes once, then again only after a while', () => {
    const key = `once-${crypto.randomUUID()}`;

    expect(noteOnce(key, 0)).toBe(true);
    expect(noteOnce(key, NOTE_ONCE_MS - 1)).toBe(false);
    expect(noteOnce(key, NOTE_ONCE_MS)).toBe(true);
  });

  it('lets go of all it remembers rather than fill memory', () => {
    const key = `kept-${crypto.randomUUID()}`;
    noteOnce(key, 0);
    for (let i = 0; i < 10_000; i++) noteOnce(`many-${i}`, 0);

    expect(noteOnce(key, 1)).toBe(true);
  });
});

describe('notingLimits', () => {
  it('writes down a sender over its limit once a while, counting an IPv6 /64 as one sender', async () => {
    const note = vi.fn();
    let address = '';
    const limited = notingLimits(async () => false, {
      addressOf: () => address,
      moderation: { ...noModeration, note },
    });
    // A /64 of its own, so that what other tests wrote down does not count.
    const net = `2001:db8:${(Date.now() % 0xffff).toString(16)}:${crypto.randomUUID().slice(0, 4)}`;

    for (const host of ['1', '2', 'abcd:1', 'ffff:ffff:ffff:ffff']) {
      address = `${net}::${host}`;
      expect(await limited(new Request('https://backend.example/'), 'read')).toBe(false);
    }
    address = `${net.slice(0, -4)}ffff::1`;
    await limited(new Request('https://backend.example/'), 'read');

    expect(note.mock.calls.map(([entry]) => (entry as Activity).address)).toEqual([`${net}::1`, address]);
  });
});
