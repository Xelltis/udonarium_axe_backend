import { describe, expect, it } from 'vitest';

import { packSecret, unpackSecret } from '../../src/core/auth/session.js';
import { base64url, readToken, signToken } from '../../src/core/auth/tokens.js';

const SECRET = 'a-secret-for-the-token-tests-only!';

const access = (seconds = 60, secret = SECRET) =>
  signToken<'access'>({ aud: 'access', sub: 'discord:1', uid: 'u1', name: 'one' }, seconds, secret);

const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

describe('signed tokens', () => {
  it('reads back what it signed, with its expiry', () => {
    const before = Math.floor(Date.now() / 1000);
    expect(readToken(access(60), 'access', SECRET)).toEqual({
      aud: 'access',
      sub: 'discord:1',
      uid: 'u1',
      name: 'one',
      exp: expect.any(Number),
    });
    expect(readToken(access(60), 'access', SECRET)?.exp).toBeGreaterThanOrEqual(before + 60);
  });

  it('takes an invite only for a role there is', () => {
    const invite = signToken<'invite'>({ aud: 'invite', room: 'r', role: 'gm' }, 60, SECRET);
    const odd = signToken<'invite'>(
      { aud: 'invite', room: 'r', role: 'owner' as 'gm' },
      60,
      SECRET,
    );
    expect(readToken(invite, 'invite', SECRET)?.role).toBe('gm');
    expect(readToken(odd, 'invite', SECRET)).toBeNull();
  });

  it.each([
    ['signed with another secret', () => access(60, 'another-secret-another-secret-123')],
    ['past its expiry', () => access(-1)],
    [
      'of another kind',
      () => signToken<'invite'>({ aud: 'invite', room: 'r', role: 'pl' }, 60, SECRET),
    ],
    [
      'with a header that asks for no signature',
      () => {
        const [, payload, signature] = access().split('.');
        return `${encode({ alg: 'none', typ: 'JWT' })}.${payload}.${signature}`;
      },
    ],
    [
      'with a changed body',
      () => {
        const [header, , signature] = access().split('.');
        return `${header}.${encode({ aud: 'access', sub: 'x', uid: 'x', name: 'x', exp: 9e9 })}.${signature}`;
      },
    ],
    ['cut short', () => access().split('.').slice(0, 2).join('.')],
    ['with an extra part', () => `${access()}.extra`],
    [
      'with a signature that is not base64',
      () => `${access().split('.').slice(0, 2).join('.')}.%%%`,
    ],
    [
      'with a body that is not JSON',
      () => {
        const [header] = access().split('.');
        return `${header}.${base64url(new TextEncoder().encode('nope'))}.x`;
      },
    ],
  ])('turns away a token %s', (_name, make) => {
    expect(readToken(make(), 'access', SECRET)).toBeNull();
  });

  it('takes nothing with an empty secret, which anybody could sign with', () => {
    expect(readToken(access(60, ''), 'access', '')).toBeNull();
  });
});

describe('packed secrets', () => {
  it('carries the account they belong to', () => {
    const packed = packSecret('discord:42', { id: 'row', secret: 'shh' });
    expect(unpackSecret(packed)).toEqual({
      accountKey: 'discord:42',
      secret: { id: 'row', secret: 'shh' },
    });
  });

  it.each(['two.parts', 'a.b.c.d', 'with space.b.c', 'a.b.c'])('reads %s as nothing', (text) => {
    expect(unpackSecret(text)).toBeNull();
  });
});
