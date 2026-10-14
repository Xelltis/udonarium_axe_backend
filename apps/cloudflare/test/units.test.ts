import { describe, expect, it } from 'vitest';

import { setContentRange } from '../src/assets/response';
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

describe('parseConfig', () => {
  const valid = {
    ACCESS_CONTROL_ALLOW_ORIGIN: ' https://a.example, ,https://b.example ',
    ASSET_RETENTION_DAYS: '30',
  };

  it('reads the settings', () => {
    expect(parseConfig(valid)).toEqual({
      allowedOrigins: ['https://a.example', 'https://b.example'],
      retentionSeconds: 30 * 24 * 60 * 60,
    });
  });

  it.each([
    ['no list of origins', { ACCESS_CONTROL_ALLOW_ORIGIN: undefined }],
    ['a retention that is not a number', { ASSET_RETENTION_DAYS: 'thirty' }],
    ['a retention under a day', { ASSET_RETENTION_DAYS: '0' }],
    ['a retention that is not whole days', { ASSET_RETENTION_DAYS: '1.5' }],
  ])('turns away %s', (_name, change) => {
    expect(() => parseConfig({ ...valid, ...change })).toThrow(ConfigError);
  });
});
