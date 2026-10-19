import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_MS, MAX_ACTIVITY } from '../../src/core/moderation/activity.js';
import type { Activity } from '../../src/core/moderation/activity.js';
import type { Passkey } from '../../src/core/admin/webauthn.js';
import type { Ban } from '../../src/core/moderation/bans.js';
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

const entryOf = (at: number, detail: string): Activity => ({ at, kind: 'admin', address: '192.0.2.1', detail });

describe('a Redis store for the operator', () => {
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
