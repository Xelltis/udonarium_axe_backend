import { describe, expect, it } from 'vitest';

import { setContentRange } from '../src/assets/response';
import { ConfigError, parseConfig } from '../src/config';
import { isAllowedOrigin } from '../src/http/origin';

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
  };

  it('reads the settings', () => {
    expect(parseConfig(valid)).toEqual({
      allowedOrigins: ['https://a.example', 'https://b.example'],
    });
  });

  it.each([['no list of origins', { ACCESS_CONTROL_ALLOW_ORIGIN: undefined }]])(
    'turns away %s',
    (_name, change) => {
      expect(() => parseConfig({ ...valid, ...change })).toThrow(ConfigError);
    },
  );
});
