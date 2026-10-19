import { describe, expect, it, vi } from 'vitest';

import { setContentRange } from '../src/assets/response';
import { ORPHAN_GRACE_MS, deleteRoomAssets, randomStart, sweepOrphans } from '../src/assets/sweep';
import { ConfigError, parseConfig } from '../src/config';

describe('setContentRange', () => {
  it.each([
    [{ offset: 10, length: 5 }, 'bytes 10-14/100', '5'],
    [{ offset: 90 }, 'bytes 90-99/100', '10'],
    [{ length: 20 }, 'bytes 0-19/100', '20'],
    [{ suffix: 30 }, 'bytes 70-99/100', '30'],
  ])('writes %o as %s', (range, contentRange, contentLength) => {
    const headers = new Headers();
    setContentRange(headers, range, 100);
    expect(headers.get('Content-Range')).toBe(contentRange);
    expect(headers.get('Content-Length')).toBe(contentLength);
  });
});

describe('sweepOrphans', () => {
  const ROOM = 'a'.repeat(32);
  const GONE = 'b'.repeat(32);
  const at = (msAgo: number) => new Date(Date.now() - msAgo);
  const bucketHolding = (
    roomObjects: { key: string; uploaded: Date }[],
    topObjects: { key: string; uploaded: Date }[] = []
  ) => {
    const bucket = {
      list: vi.fn(async (options: R2ListOptions) => ({
        objects: options.prefix === 'rooms/' ? roomObjects : topObjects,
      })),
      delete: vi.fn(async () => undefined),
    };
    return bucket as typeof bucket & R2Bucket;
  };

  it('deletes what is kept for a room no longer listed, once it is past the grace', async () => {
    const kept = `rooms/${ROOM}/${'1'.repeat(64)}`;
    const orphan = `rooms/${GONE}/${'2'.repeat(64)}`;
    const fresh = `rooms/${GONE}/${'3'.repeat(64)}`;
    const bucket = bucketHolding([
      { key: kept, uploaded: at(2 * ORPHAN_GRACE_MS) },
      { key: orphan, uploaded: at(2 * ORPHAN_GRACE_MS) },
      { key: fresh, uploaded: at(ORPHAN_GRACE_MS / 2) },
    ]);
    const known = vi.fn(async () => [ROOM]);

    expect(await sweepOrphans(bucket, known, 'start')).toBe(1);

    expect(bucket.list).toHaveBeenCalledWith({
      prefix: 'rooms/',
      startAfter: 'rooms/start',
      limit: 1000,
    });
    expect(known).toHaveBeenCalledWith([ROOM, GONE]);
    expect(bucket.delete).toHaveBeenCalledWith([orphan]);
  });

  it('deletes what was kept for every room before rooms had their own, but no take-down marker', async () => {
    const legacy = 'c'.repeat(64);
    const bucket = bucketHolding(
      [],
      [
        { key: legacy, uploaded: at(0) },
        { key: `blocked/${'d'.repeat(64)}`, uploaded: at(0) },
        { key: `rooms/${ROOM}/${'e'.repeat(64)}`, uploaded: at(0) },
      ]
    );
    const known = vi.fn(async () => []);

    expect(await sweepOrphans(bucket, known, 'start')).toBe(1);

    expect(known).not.toHaveBeenCalled();
    expect(bucket.list).toHaveBeenCalledWith({ startAfter: 'start', limit: 1000 });
    expect(bucket.delete).toHaveBeenCalledWith([legacy]);
  });

  it('deletes nothing when every room is still there', async () => {
    const bucket = bucketHolding([{ key: `rooms/${ROOM}/${'f'.repeat(64)}`, uploaded: at(2 * ORPHAN_GRACE_MS) }]);

    expect(await sweepOrphans(bucket, async () => [ROOM], 'start')).toBe(0);

    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('starts from a random place shaped like a room key', () => {
    expect(randomStart()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomStart()).not.toBe(randomStart());
  });
});

describe('deleteRoomAssets', () => {
  it('deletes every page of a room’s assets, and only the room’s', async () => {
    const pages = [
      { objects: [{ key: 'rooms/r/1' }, { key: 'rooms/r/2' }], truncated: true, cursor: 'next' },
      { objects: [{ key: 'rooms/r/3' }], truncated: false },
      { objects: [], truncated: false },
    ];
    const bucket = {
      list: vi.fn(async () => pages.shift()),
      delete: vi.fn(async () => undefined),
    } as unknown as R2Bucket & { list: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

    expect(await deleteRoomAssets(bucket, 'r')).toBe(3);
    expect(await deleteRoomAssets(bucket, 'r')).toBe(0);

    expect(bucket.list).toHaveBeenNthCalledWith(1, { prefix: 'rooms/r/', limit: 1000 });
    expect(bucket.list).toHaveBeenNthCalledWith(2, {
      prefix: 'rooms/r/',
      limit: 1000,
      cursor: 'next',
    });
    expect(bucket.delete).toHaveBeenCalledTimes(2);
  });
});

describe('parseConfig', () => {
  const valid = {
    ACCESS_CONTROL_ALLOW_ORIGIN: ' https://a.example, ,https://b.example ',
    ROOM_RETENTION_HOURS: '24',
  };

  it('reads the settings', () => {
    expect(parseConfig(valid)).toEqual({
      allowedOrigins: ['https://a.example', 'https://b.example'],
      roomRetentionSeconds: 24 * 60 * 60,
      login: null,
      admin: null,
      adminWebhook: null,
    });
  });

  it('reads the webhook for alerts', () => {
    const url = 'https://discord.com/api/webhooks/1/token';
    expect(parseConfig({ ...valid, ADMIN_WEBHOOK_URL: url }).adminWebhook).toBe(url);
    expect(parseConfig({ ...valid, ADMIN_WEBHOOK_URL: '' }).adminWebhook).toBeNull();
  });

  it('reads who may open the dashboard', () => {
    expect(parseConfig({ ...valid, ADMIN_DISCORD_IDS: ' 1, 22 ,', ADMIN_PASSKEY_RESET: '22' }).admin).toEqual({
      discordIds: ['1', '22'],
      passkeyReset: ['22'],
    });
    expect(parseConfig({ ...valid, ADMIN_DISCORD_IDS: '1' }).admin).toEqual({ discordIds: ['1'], passkeyReset: [] });
    expect(parseConfig({ ...valid, ADMIN_DISCORD_IDS: ' , ' }).admin).toBeNull();
  });

  it('reads the login settings when all three are there', () => {
    const login = {
      DISCORD_CLIENT_ID: 'client',
      DISCORD_CLIENT_SECRET: 'client-secret',
      SESSION_SECRET: 's'.repeat(32),
    };
    expect(parseConfig({ ...valid, ...login }).login).toEqual({
      discordClientId: 'client',
      discordClientSecret: 'client-secret',
      sessionSecret: 's'.repeat(32),
    });
  });

  it.each([
    ['no list of origins', { ACCESS_CONTROL_ALLOW_ORIGIN: undefined }],
    ['a room retention that is not a number', { ROOM_RETENTION_HOURS: 'a day' }],
    ['a room retention that is not whole hours', { ROOM_RETENTION_HOURS: '1.5' }],
    ['no room retention', { ROOM_RETENTION_HOURS: undefined }],
    ['a room retention under an hour', { ROOM_RETENTION_HOURS: '0' }],
    ['only part of the login settings', { DISCORD_CLIENT_ID: 'client', SESSION_SECRET: 's'.repeat(32) }],
    [
      'a session secret that is too short',
      { DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 'c', SESSION_SECRET: 'short' },
    ],
    ['an operator that is not a Discord user id', { ADMIN_DISCORD_IDS: '1,someone' }],
    ['a reset for one that is not a Discord user id', { ADMIN_DISCORD_IDS: '1', ADMIN_PASSKEY_RESET: 'x' }],
    ['a webhook that is not https', { ADMIN_WEBHOOK_URL: 'http://discord.com/api/webhooks/1/token' }],
    ['a webhook that is not a URL', { ADMIN_WEBHOOK_URL: 'discord' }],
  ])('turns away %s', (_name, change) => {
    expect(() => parseConfig({ ...valid, ...change })).toThrow(ConfigError);
  });
});
