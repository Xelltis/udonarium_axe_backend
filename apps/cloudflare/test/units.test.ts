import { describe, expect, it } from 'vitest';

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
