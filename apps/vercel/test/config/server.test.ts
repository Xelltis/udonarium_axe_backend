import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOM_RETENTION_HOURS,
  DEFAULT_ROOM_SOCKET_SECONDS,
  parseServerConfig,
} from '../../src/config/server.js';
import { ConfigError } from '../../src/core/config/login.js';

const LOGIN = {
  DISCORD_CLIENT_ID: 'id',
  DISCORD_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('parseServerConfig', () => {
  it('reads the origins, and the defaults of the rest', () => {
    expect(parseServerConfig({ ACCESS_CONTROL_ALLOW_ORIGIN: 'https://a.example, https://b.example ,' })).toEqual({
      allowedOrigins: ['https://a.example', 'https://b.example'],
      login: null,
      roomRetentionSeconds: DEFAULT_ROOM_RETENTION_HOURS * 3600,
      roomSocketSeconds: DEFAULT_ROOM_SOCKET_SECONDS,
      redisUrl: null,
      redisKeyPrefix: 'axe:',
      blob: null,
      cronSecret: null,
      admin: null,
      adminWebhook: null,
      storageAlertBytes: null,
      roomStorageLimitBytes: null,
      contactUrl: null,
    });
  });

  it('reads all that is given', () => {
    expect(
      parseServerConfig({
        ACCESS_CONTROL_ALLOW_ORIGIN: '*',
        ...LOGIN,
        REDIS_URL: 'redis://redis.example:6379',
        REDIS_KEY_PREFIX: 'mine:',
        BLOB_READ_WRITE_TOKEN: 'token',
        ROOM_RETENTION_HOURS: '2',
        ROOM_SOCKET_SECONDS: '120',
        CRON_SECRET: 'cron',
        ADMIN_DISCORD_IDS: '1,2',
        ADMIN_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/token',
      })
    ).toMatchObject({
      login: {
        discordClientId: 'id',
        discordClientSecret: 'secret',
        sessionSecret: 'x'.repeat(32),
      },
      roomRetentionSeconds: 7200,
      roomSocketSeconds: 120,
      redisUrl: 'redis://redis.example:6379',
      redisKeyPrefix: 'mine:',
      blob: { kind: 'vercel' },
      cronSecret: 'cron',
      admin: { discordIds: ['1', '2'], passkeyReset: [] },
      adminWebhook: 'https://discord.com/api/webhooks/1/token',
    });
  });

  it('takes the Redis of the Vercel Marketplace, and a Blob store connected by its ID', () => {
    expect(
      parseServerConfig({
        ACCESS_CONTROL_ALLOW_ORIGIN: '*',
        ...LOGIN,
        REDIS_URL: '',
        KV_URL: 'rediss://kv.example',
        BLOB_STORE_ID: 'store',
      })
    ).toMatchObject({ redisUrl: 'rediss://kv.example', blob: { kind: 'vercel' } });
  });

  it('keeps assets in a directory only off Vercel', () => {
    const local = { ACCESS_CONTROL_ALLOW_ORIGIN: '*', BLOB_LOCAL_DIR: '.blob' };

    expect(parseServerConfig(local).blob).toEqual({ kind: 'local', dir: '.blob' });
    expect(() => parseServerConfig({ ...local, VERCEL: '1' })).toThrow(ConfigError);
  });

  it('needs Redis and a Blob store once login is set up', () => {
    const base = { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ...LOGIN };

    expect(() => parseServerConfig(base)).toThrow(/REDIS_URL/);
    expect(() => parseServerConfig({ ...base, REDIS_URL: 'redis://r' })).toThrow(/BLOB/);
  });

  it('reads where someone turned away can ask', () => {
    expect(
      parseServerConfig({ ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_CONTACT_URL: 'mailto:op@a.example' }).contactUrl
    ).toBe('mailto:op@a.example');
  });

  it('reads the store’s size to tell the operator past, or none when it is left empty', () => {
    expect(
      parseServerConfig({ ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_STORAGE_ALERT_GB: '2.5' }).storageAlertBytes
    ).toBe(2_500_000_000);
    expect(
      parseServerConfig({ ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_STORAGE_ALERT_GB: '' }).storageAlertBytes
    ).toBeNull();
  });

  it.each([
    ['no origins', {}],
    ['a socket that rotates too soon', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ROOM_SOCKET_SECONDS: '30' }],
    ['only part of the login', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', DISCORD_CLIENT_ID: 'id' }],
    ['a webhook that is not https', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_WEBHOOK_URL: 'http://discord.com/x' }],
    ['a webhook that is not a URL', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_WEBHOOK_URL: 'discord' }],
    ['a store size that is not a number of GB', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_STORAGE_ALERT_GB: 'ten' }],
    ['a contact that is not a URL', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_CONTACT_URL: 'ask the GM' }],
    [
      'a room limit that is not a whole number of MB',
      { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ROOM_STORAGE_LIMIT_MB: 'lots' },
    ],
    ['an operator that is not a Discord user id', { ACCESS_CONTROL_ALLOW_ORIGIN: '*', ADMIN_DISCORD_IDS: 'someone' }],
  ])('turns away %s', (_name, env) => {
    expect(() => parseServerConfig(env)).toThrow(ConfigError);
  });
});
