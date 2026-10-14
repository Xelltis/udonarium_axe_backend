import { describe, expect, it, vi } from 'vitest';

import { setContentRange } from '../src/assets/response';
import { randomStart, sweepExpired } from '../src/assets/sweep';
import { ConfigError, parseConfig } from '../src/config';
import { networkOf } from '../src/http/network';
import { isAllowedOrigin } from '../src/http/origin';

describe('networkOf', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002::0005', '2001:db8:1:2::/64'],
    ['2001:DB8::1', '2001:db8:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
  ])('counts %s as %s', (address, network) => {
    expect(networkOf(address)).toBe(network);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['https://app.example', 'http://localhost:4200', 'not a url'];

  it.each([
    ['https://app.example', true],
    ['https://app.example/', true],
    ['http://app.example', false],
    ['https://app.example:8443', false],
    ['http://localhost:4200', true],
    ['http://localhost:4300', false],
    ['not a url', false],
    [undefined, false],
  ])('answers %s with %s', (origin, expected) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(expected);
  });

  it('lets every origin in with *', () => {
    expect(isAllowedOrigin('https://anywhere.example', ['*'])).toBe(true);
  });
});

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

describe('sweepExpired', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const bucketHolding = (...objects: { key: string; uploaded: Date }[]) => {
    const bucket = { list: vi.fn(async () => ({ objects })), delete: vi.fn(async () => undefined) };
    return bucket as typeof bucket & R2Bucket;
  };

  it('deletes the objects past their retention in one page after the start', async () => {
    const bucket = bucketHolding(
      { key: 'old', uploaded: new Date(Date.now() - 31 * DAY_MS) },
      { key: 'fresh', uploaded: new Date(Date.now() - DAY_MS) },
      { key: 'older', uploaded: new Date(Date.now() - 90 * DAY_MS) },
    );

    expect(await sweepExpired(bucket, 30 * 24 * 60 * 60, 'start')).toBe(2);

    expect(bucket.list).toHaveBeenCalledWith({ startAfter: 'start', limit: 1000 });
    expect(bucket.delete).toHaveBeenCalledWith(['old', 'older']);
  });

  it('deletes nothing when nothing has run out', async () => {
    const bucket = bucketHolding({ key: 'fresh', uploaded: new Date() });

    expect(await sweepExpired(bucket, 30 * 24 * 60 * 60, 'start')).toBe(0);

    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it('starts from a random place shaped like a name', () => {
    expect(randomStart()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomStart()).not.toBe(randomStart());
  });
});

describe('parseConfig', () => {
  const valid = {
    ACCESS_CONTROL_ALLOW_ORIGIN: ' https://a.example, ,https://b.example ',
    ASSET_RETENTION_DAYS: '30',
    ROOM_RETENTION_HOURS: '24',
  };

  it('reads the settings', () => {
    expect(parseConfig(valid)).toEqual({
      allowedOrigins: ['https://a.example', 'https://b.example'],
      retentionSeconds: 30 * 24 * 60 * 60,
      roomRetentionSeconds: 24 * 60 * 60,
      login: null,
    });
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
    ['a retention that is not a number', { ASSET_RETENTION_DAYS: 'thirty' }],
    ['a retention under a day', { ASSET_RETENTION_DAYS: '0' }],
    ['a retention that is not whole days', { ASSET_RETENTION_DAYS: '1.5' }],
    ['no room retention', { ROOM_RETENTION_HOURS: undefined }],
    ['a room retention under an hour', { ROOM_RETENTION_HOURS: '0' }],
    [
      'only part of the login settings',
      { DISCORD_CLIENT_ID: 'client', SESSION_SECRET: 's'.repeat(32) },
    ],
    [
      'a session secret that is too short',
      { DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 'c', SESSION_SECRET: 'short' },
    ],
  ])('turns away %s', (_name, change) => {
    expect(() => parseConfig({ ...valid, ...change })).toThrow(ConfigError);
  });
});
