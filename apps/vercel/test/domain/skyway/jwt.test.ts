import { buildJwtHeader, buildJwtPayload, signJwt } from '../../../src/domain/skyway/jwt.js';

describe('buildJwtHeader', () => {
  it('returns HS256 / JWT header', () => {
    expect(buildJwtHeader()).toEqual({ alg: 'HS256', typ: 'JWT' });
  });
});

describe('buildJwtPayload', () => {
  it('derives exp from iat + ttlSeconds and embeds scope', () => {
    const payload = buildJwtPayload({
      appId: 'app',
      scopes: [],
      jti: 'jti-1',
      iat: 1_000,
      ttlSeconds: 60,
    });
    expect(payload).toEqual({
      jti: 'jti-1',
      iat: 1_000,
      exp: 1_060,
      version: 2,
      scope: { app: { id: 'app', turn: true, actions: ['read'], channels: [] } },
    });
  });
});

describe('signJwt', () => {
  it('joins encoded header, payload, and signature', async () => {
    const calls: string[] = [];
    const deps = {
      hmacSHA256: async (message: string, secret: string) => {
        calls.push(`hmac:${message}:${secret}`);
        return new TextEncoder().encode('sig').buffer;
      },
      encode: (input: string | ArrayBuffer) => {
        if (typeof input === 'string') return `enc(${input})`;
        return `enc(buf:${new TextDecoder().decode(new Uint8Array(input))})`;
      },
    };
    const token = await signJwt(
      { alg: 'HS256', typ: 'JWT' },
      {
        jti: 'jti',
        iat: 1,
        exp: 2,
        version: 2,
        scope: { app: { id: 'app', turn: true, actions: ['read'], channels: [] } },
      },
      'secret',
      deps,
    );
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^enc\(/);
    expect(parts[1]).toMatch(/^enc\(/);
    expect(parts[2]).toBe('enc(buf:sig)');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`hmac:${parts[0]}.${parts[1]}:secret`);
  });
});
