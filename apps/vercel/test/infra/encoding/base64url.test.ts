import { decode, encode } from '../../../src/infra/encoding/base64url.js';

const encoder = new TextEncoder();

describe('base64url.encode/decode', () => {
  it('roundtrips a UTF-8 string', () => {
    const original = 'hello world';
    const decoded = new Uint8Array(decode(encode(original)));
    expect(Array.from(decoded)).toEqual(Array.from(encoder.encode(original)));
  });

  it('roundtrips binary data', () => {
    const data = new Uint8Array([0, 255, 1, 2, 3]);
    const decoded = new Uint8Array(decode(encode(data.buffer)));
    expect(Array.from(decoded)).toEqual(Array.from(data));
  });

  it('produces url-safe output without padding', () => {
    const encoded = encode('\xfb\xff\xfe');
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
