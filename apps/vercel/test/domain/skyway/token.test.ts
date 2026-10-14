import { issueSkywayToken } from '../../../src/domain/skyway/token.js';
import type { IssueTokenDeps } from '../../../src/domain/skyway/types.js';

const buildDeps = (overrides: Partial<IssueTokenDeps> = {}): IssueTokenDeps => ({
  config: { appId: 'app', secret: 'secret', lobbySize: 3, tokenTtlSeconds: 86_400 },
  uuid: () => 'fixed-uuid',
  now: () => 1_000,
  hmacSHA256: async () => new ArrayBuffer(8),
  encode: () => 'X',
  ...overrides,
});

describe('issueSkywayToken', () => {
  it('returns a three-part JWT string', async () => {
    const deps = buildDeps({ encode: (input) => (typeof input === 'string' ? 'P' : 'S') });
    const token = await issueSkywayToken({ channelName: 'room', peerId: 'peer' }, deps);
    expect(token).toBe('P.P.S');
  });

  it('defaults jti to uuid() and iat to now() when omitted', async () => {
    let capturedHmacMessage = '';
    const deps = buildDeps({
      uuid: () => 'generated-uuid',
      now: () => 12_345,
      hmacSHA256: async (message) => {
        capturedHmacMessage = message;
        return new ArrayBuffer(0);
      },
      encode: (input) => {
        if (typeof input === 'string') return Buffer.from(input).toString('base64url');
        return '';
      },
    });
    await issueSkywayToken({ channelName: 'room', peerId: 'peer' }, deps);
    const [header, payload] = capturedHmacMessage.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(parsed.jti).toBe('generated-uuid');
    expect(parsed.iat).toBe(12_345);
    expect(parsed.exp).toBe(12_345 + 86_400);
  });

  it('uses supplied jti and iat when provided', async () => {
    let capturedPayload: Record<string, unknown> = {};
    const deps = buildDeps({
      encode: (input) => {
        if (typeof input === 'string') {
          const parsed = (() => {
            try {
              return JSON.parse(input) as Record<string, unknown>;
            } catch {
              return null;
            }
          })();
          if (parsed && 'jti' in parsed) capturedPayload = parsed;
          return 'X';
        }
        return 'S';
      },
    });
    await issueSkywayToken(
      { channelName: 'room', peerId: 'peer', jti: 'supplied-jti', iat: 42 },
      deps,
    );
    expect(capturedPayload.jti).toBe('supplied-jti');
    expect(capturedPayload.iat).toBe(42);
  });

  it('uses tokenTtlSeconds from config for exp', async () => {
    let capturedExp = 0;
    const deps = buildDeps({
      config: { appId: 'app', secret: 'secret', lobbySize: 3, tokenTtlSeconds: 3_600 },
      now: () => 100,
      encode: (input) => {
        if (typeof input === 'string') {
          try {
            const parsed = JSON.parse(input) as { exp?: number };
            if (parsed.exp != null) capturedExp = parsed.exp;
          } catch {
            /* ignore non-JSON */
          }
          return 'X';
        }
        return 'S';
      },
    });
    await issueSkywayToken({ channelName: 'room', peerId: 'peer' }, deps);
    expect(capturedExp).toBe(100 + 3_600);
  });

  it('builds both lobby and room scopes from peerId/channelName/lobbySize', async () => {
    let capturedChannels: { name: string }[] = [];
    const deps = buildDeps({
      config: { appId: 'app', secret: 'secret', lobbySize: 5, tokenTtlSeconds: 86_400 },
      encode: (input) => {
        if (typeof input === 'string') {
          try {
            const parsed = JSON.parse(input) as {
              scope?: { app: { channels: { name: string }[] } };
            };
            if (parsed.scope) capturedChannels = parsed.scope.app.channels;
          } catch {
            /* ignore non-JSON */
          }
          return 'X';
        }
        return 'S';
      },
    });
    await issueSkywayToken({ channelName: 'my-room', peerId: 'peer-x' }, deps);
    expect(capturedChannels.map((c) => c.name)).toEqual(['udonarium-lobby-*-of-5', 'my-room']);
  });
});
