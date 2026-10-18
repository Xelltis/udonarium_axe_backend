import { hmacSHA256 } from '../../../src/infra/crypto/hmac.js';

describe('hmacSHA256', () => {
  it('returns a 32-byte ArrayBuffer', async () => {
    const sig = await hmacSHA256('msg', 'secret');
    expect(sig).toBeInstanceOf(ArrayBuffer);
    expect(sig.byteLength).toBe(32);
  });

  it('is deterministic for the same message/secret', async () => {
    const a = new Uint8Array(await hmacSHA256('msg', 'secret'));
    const b = new Uint8Array(await hmacSHA256('msg', 'secret'));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('accepts ArrayBuffer inputs', async () => {
    const message = new TextEncoder().encode('msg');
    const secret = new TextEncoder().encode('secret');
    const a = new Uint8Array(await hmacSHA256(message.buffer, secret.buffer));
    const b = new Uint8Array(await hmacSHA256('msg', 'secret'));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
