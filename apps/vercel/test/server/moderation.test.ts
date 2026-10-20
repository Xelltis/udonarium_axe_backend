import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACTIVITY_MS,
  MAX_ACTIVITY,
  MAX_OPERATOR_ACTIVITY,
  OPERATOR_ACTIVITY_MS,
} from '../../src/core/moderation/activity.js';
import type { Activity } from '../../src/core/moderation/activity.js';
import type { Passkey } from '../../src/core/admin/webauthn.js';
import type { Ban } from '../../src/core/moderation/bans.js';
import { MAX_REPORTS, MAX_REPORTS_PER_REPORTER, REPORTER_MS, REPORT_MS } from '../../src/core/moderation/reports.js';
import type { Report } from '../../src/core/moderation/reports.js';
import { redisModeration } from '../../src/server/moderation.js';
import { freshKey, useRedis } from './redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

const banOf = (value: string, createdAt: number, expiresAt: number | null = null): Ban => ({
  kind: 'discord',
  value,
  reason: '',
  createdAt,
  expiresAt,
});

const entryOf = (at: number, detail: string): Activity => ({ at, kind: 'login', address: '192.0.2.1', detail });
const stepOf = (at: number, detail: string): Activity => ({ at, kind: 'admin', address: '192.0.2.9', detail });

/** How many reports the stores here keep, so that filling one does not take long. */
const FEW = 10;

/** A report, by a reporter of its own unless one is given. */
const reportOf = (id: string, at: number, discordId: string | null = id): Report => ({
  id,
  at,
  roomKey: '0'.repeat(32),
  target: 'room',
  assetId: null,
  reason: 'x',
  reporter: { address: '192.0.2.1', discordId, userId: 'u', role: 'pl' },
  status: 'open',
  handledAt: null,
  handledBy: null,
});

describe('a Redis store for the operator', () => {
  it('orders reports made at the same moment by their ids', async () => {
    const store = redisModeration(connection.redis, freshKey());
    const now = Date.now();
    await store.putReport(reportOf('b', now));
    await store.putReport(reportOf('a', now));

    expect((await store.reports()).map((report) => report.id)).toEqual(['a', 'b']);
  });

  it('keeps reports newest first, lets the oldest go past the most kept or REPORT_MS, and sets what came of one', async () => {
    const key = freshKey();
    // Kept to a few here, so that filling it does not take long.
    const store = redisModeration(connection.redis, key, FEW);
    const now = Date.now();
    for (let i = 0; i < FEW; i++) await store.putReport(reportOf(`r${i}`, now - FEW + i));
    expect(await store.putReport(reportOf('too-old', now - REPORT_MS - 1))).toBe(true);
    expect(await store.putReport(reportOf('newest', now + 1))).toBe(true);
    // One grown too old since the last was kept is left out until the next lets it go.
    const stale = reportOf('stale', now - REPORT_MS - 1);
    await connection.redis.hSet(key('mod', 'reports'), stale.id, JSON.stringify(stale));

    const kept = await store.reports();
    expect(kept).toHaveLength(FEW);
    expect(kept[0].id).toBe('newest');
    expect(kept.some((report) => report.id === 'too-old' || report.id === 'r0')).toBe(false);
    expect(await connection.redis.hLen(key('mod', 'reports'))).toBe(FEW + 1);
    expect(await connection.redis.zCard(key('mod', 'reports', 'at'))).toBe(FEW);
    expect(await store.setReportStatus('missing', 'done', '1', 5)).toBeNull();
    expect(await store.setReportStatus('r1', 'dismissed', '1', 5)).toMatchObject({
      status: 'dismissed',
      handledBy: '1',
    });
    expect((await store.reports()).find((report) => report.id === 'r1')?.status).toBe('dismissed');
  });

  it('lets the oldest of whoever kept the most go past the most kept, not that of someone with one', async () => {
    const store = redisModeration(connection.redis, freshKey(), FEW);
    const now = Date.now();
    await store.putReport(reportOf('lonely', now - 10));
    for (let i = 0; i < 5; i++) await store.putReport(reportOf(`flood${i}`, now - 9 + i, 'flood'));
    for (let i = 0; i < FEW - 6; i++) await store.putReport(reportOf(`one${i}`, now));
    await store.putReport(reportOf('one more', now));
    const ids = new Set((await store.reports()).map((report) => report.id));

    expect(ids.size).toBe(FEW);
    expect(ids.has('lonely')).toBe(true);
    expect(ids.has('flood0')).toBe(false);
    expect(ids.has('flood1')).toBe(true);
  });

  it('keeps MAX_REPORTS unless told otherwise', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);
    // Ids by time with no report behind them, as one let go at the same moment on another instance.
    await connection.redis.zAdd(key('mod', 'reports', 'at'), [
      ...Array.from({ length: MAX_REPORTS }, (_, i) => ({ score: Date.now(), value: `seeded${i}` })),
      { score: 1, value: 'gone' },
    ]);

    await store.putReport(reportOf('one', Date.now()));

    expect(await connection.redis.zCard(key('mod', 'reports', 'at'))).toBe(MAX_REPORTS);
  });

  it('keeps no more than MAX_REPORTS_PER_REPORTER from one reporter a day, those from a sender counted by its /64', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);
    const now = Date.now();
    const answers: boolean[] = [];
    answers.push(await store.putReport(reportOf('yesterday', now - REPORTER_MS, 'same')));
    for (let i = 0; i <= MAX_REPORTS_PER_REPORTER; i++)
      answers.push(await store.putReport(reportOf(`d${i}`, now, 'same')));
    for (let i = 0; i <= MAX_REPORTS_PER_REPORTER; i++) {
      const report = reportOf(`a${i}`, now, null);
      answers.push(
        await store.putReport({ ...report, reporter: { ...report.reporter, address: `2001:db8::${i + 1}` } })
      );
    }
    answers.push(await store.putReport(reportOf('someone else', now)));

    const fromOne = [true, ...Array<boolean>(MAX_REPORTS_PER_REPORTER).fill(true), false];
    expect(answers).toEqual([...fromOne, ...fromOne.slice(1), true]);
    expect(await connection.redis.pTTL(key('mod', 'reporter', 'discord:same'))).toBeGreaterThan(REPORT_MS - 60_000);
  });

  it('keeps how tight the limits are, and when that began, until they go back', async () => {
    const store = redisModeration(connection.redis, freshKey());

    expect((await store.state()).tighten).toEqual({ upload: 1, read: 1, room: 1, auth: 1, since: null });
    await store.setTighten({ upload: 4, read: 1, room: 10, auth: 2, since: 7 });
    expect((await store.state()).tighten).toEqual({ upload: 4, read: 1, room: 10, auth: 2, since: 7 });
    await store.setTighten({ upload: 1, read: 1, room: 1, auth: 1, since: null });
    expect((await store.state()).tighten).toEqual({ upload: 1, read: 1, room: 1, auth: 1, since: null });
  });

  it('keeps the store’s size as last counted', async () => {
    const store = redisModeration(connection.redis, freshKey());

    expect(await store.storageUsage()).toBeNull();
    await store.putStorageUsage({ bytes: 12_345_678_901, assets: 7, at: 3, complete: false });
    expect(await store.storageUsage()).toEqual({ bytes: 12_345_678_901, assets: 7, at: 3, complete: false });
  });

  it('keeps what the operator stopped, and when, until it is started again', async () => {
    const store = redisModeration(connection.redis, freshKey());

    expect((await store.state()).pause).toEqual({ rooms: false, uploads: false, logins: false, since: null });
    await store.setPause({ rooms: true, uploads: false, logins: true, since: 7 });
    expect((await store.state()).pause).toEqual({ rooms: true, uploads: false, logins: true, since: 7 });
    await store.setPause({ rooms: false, uploads: false, logins: false, since: null });
    expect((await store.state()).pause).toEqual({ rooms: false, uploads: false, logins: false, since: null });
  });

  it('keeps the operators’ passkeys oldest first, the generation of their sessions, and challenges taken', async () => {
    const store = redisModeration(connection.redis, freshKey());
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

  it('remembers a session logged out of until it would have run out anyway', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);

    expect(await store.sessionEnded('a')).toBe(false);
    await store.endSession('a', 60_000);
    expect(await store.sessionEnded('a')).toBe(true);
    expect(await connection.redis.pTTL(key('mod', 'ended', 'a'))).toBeGreaterThan(50_000);
  });

  it('lets one instance send each kind of alert once in a while', async () => {
    const store = redisModeration(connection.redis, freshKey());

    expect(await store.claimAlert('limited', 60_000)).toBe(true);
    expect(await store.claimAlert('limited', 60_000)).toBe(false);
    expect(await store.claimAlert('refused', 60_000)).toBe(true);
  });

  it('lists the bans in force newest first, by value at the same moment, and lets those past their end go', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);
    const now = Date.now();
    await store.putBan(banOf('b', now));
    await store.putBan(banOf('a', now));
    await store.putBan(banOf('c', now + 1, now + 60_000));
    await store.putBan(banOf('ended', now, now - 1));

    expect((await store.bans()).map((ban) => ban.value)).toEqual(['c', 'a', 'b']);
    expect(await connection.redis.hExists(key('mod', 'bans'), 'discord:ended')).toBe(0);
    expect(await store.deleteBan('discord', 'a')).toBe(true);
    expect(await store.deleteBan('discord', 'a')).toBe(false);
    expect((await store.bans()).map((ban) => ban.value)).toEqual(['c', 'b']);
  });

  it('keeps the newest MAX_ACTIVITY, nothing older than ACTIVITY_MS, and two alike apart', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);
    const now = Date.now();
    await store.note(entryOf(now - ACTIVITY_MS - 1, 'too old'));
    await store.note(entryOf(now, 'twin'));
    await store.note(entryOf(now, 'twin'));
    for (let i = 1; i <= MAX_ACTIVITY; i++) await store.note(entryOf(now + i, `n${i}`));

    const activity = await store.activity();

    expect(activity).toHaveLength(MAX_ACTIVITY);
    expect(activity[0]).toEqual(entryOf(now + MAX_ACTIVITY, `n${MAX_ACTIVITY}`));
    expect(activity.at(-1)?.detail).toBe('n1');
    expect(await connection.redis.zCard(key('mod', 'activity'))).toBe(MAX_ACTIVITY);
    expect(await connection.redis.pTTL(key('mod', 'activity'))).toBeGreaterThan(ACTIVITY_MS - 60_000);
  });

  it('keeps the operators’ own steps apart, the newest MAX_OPERATOR_ACTIVITY for 90 days, however many of the rest come', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);
    const now = Date.now();
    await store.note(stepOf(now - OPERATOR_ACTIVITY_MS - 1, 'too old'));
    await store.note(stepOf(now - ACTIVITY_MS - 1, 'view asset a'));
    await store.note(stepOf(now - 1, 'denied not-allowed'));
    for (let i = 0; i < MAX_ACTIVITY; i++) await store.note(entryOf(now, `n${i}`));

    const activity = await store.activity();

    expect(activity).toHaveLength(MAX_ACTIVITY + 1);
    expect(activity.at(-1)?.detail).toBe('view asset a');
    expect(activity.some((entry) => entry.detail === 'denied not-allowed' || entry.detail === 'too old')).toBe(false);
    expect(await connection.redis.pTTL(key('mod', 'operator-activity'))).toBeGreaterThan(OPERATOR_ACTIVITY_MS - 60_000);
    for (let i = 0; i < MAX_OPERATOR_ACTIVITY; i++) await store.note(stepOf(now, `ban ip ${i}`));
    expect(await connection.redis.zCard(key('mod', 'operator-activity'))).toBe(MAX_OPERATOR_ACTIVITY);
  });

  it('keeps two alike written at the same moment, and does not show one grown too old', async () => {
    const key = freshKey();
    const store = redisModeration(connection.redis, key);
    const now = Date.now();
    await store.note(entryOf(now, 'twin'));
    await store.note(entryOf(now, 'twin'));
    vi.spyOn(Date, 'now').mockReturnValue(now + ACTIVITY_MS + 1);

    expect(await store.activity()).toEqual([]);
    vi.restoreAllMocks();
    expect(await store.activity()).toEqual([entryOf(now, 'twin'), entryOf(now, 'twin')]);
  });
});
