import { encodeData, encodeText } from '../../../src/infra/crypto/encoding.js';

describe('encoding', () => {
  it('encodeText returns Uint8Array', () => {
    const result = encodeText('abc');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([97, 98, 99]);
  });

  it('encodeData handles strings', () => {
    expect(encodeData('abc')).toBeInstanceOf(Uint8Array);
  });

  it('encodeData handles ArrayBuffers', () => {
    const buf = new ArrayBuffer(3);
    expect(encodeData(buf)).toBeInstanceOf(Uint8Array);
  });
});
