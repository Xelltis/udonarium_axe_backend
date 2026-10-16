import { isAllowedOrigin, tryParseUrl } from '../../../src/infra/url/origin.js';

describe('tryParseUrl', () => {
  it('returns URL for valid input', () => {
    const result = tryParseUrl('https://example.com');
    expect(result).not.toBeNull();
    expect(result?.hostname).toBe('example.com');
  });

  it('returns null for invalid input', () => {
    expect(tryParseUrl('not a url')).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  it('matches when wildcard is in allow list', () => {
    expect(isAllowedOrigin('https://anything.example', ['*'])).toBe(true);
  });

  it('returns false when request origin is missing', () => {
    expect(isAllowedOrigin(undefined, ['https://example.com'])).toBe(false);
  });

  it('returns false when request origin is invalid', () => {
    expect(isAllowedOrigin('not a url', ['https://example.com'])).toBe(false);
  });

  it('matches host, protocol, and port', () => {
    expect(isAllowedOrigin('https://example.com', ['https://example.com'])).toBe(true);
  });

  it('rejects different hosts', () => {
    expect(isAllowedOrigin('https://evil.example', ['https://example.com'])).toBe(false);
  });

  it('rejects different protocols', () => {
    expect(isAllowedOrigin('http://example.com', ['https://example.com'])).toBe(false);
  });

  it('rejects different ports', () => {
    expect(isAllowedOrigin('https://example.com:8443', ['https://example.com'])).toBe(false);
  });

  it('skips invalid entries in the allow list', () => {
    expect(isAllowedOrigin('https://example.com', ['not a url', 'https://example.com'])).toBe(true);
  });
});
