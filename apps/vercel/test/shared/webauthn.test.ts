import { describe, expect, it } from 'vitest';

import { rawSignatureOf, verifyAssertion, verifyRegistration } from '../../src/core/admin/webauthn.js';
import type { Passkey } from '../../src/core/admin/webauthn.js';
import { base64url } from '../../src/core/auth/tokens.js';
import {
  SITE,
  USER_PRESENT,
  assertionOf,
  authenticatorDataOf,
  clientDataOf,
  registrationOf,
  softPasskey,
} from './passkey-helpers.js';

// Checking what the browser hands back for passkeys: made, and signing.

const CHALLENGE = base64url(new TextEncoder().encode('the challenge'));
const expected = { challenge: CHALLENGE, ...SITE };

const stored = (passkey: Awaited<ReturnType<typeof softPasskey>>, signCount = 0): Passkey => ({
  id: passkey.id,
  discordId: '1',
  publicKey: passkey.publicKey,
  algorithm: passkey.algorithm,
  name: 'test',
  createdAt: 0,
  usedAt: null,
  signCount,
});

describe('verifyRegistration', () => {
  it('takes a passkey made for this challenge, origin and site, with the user verified', async () => {
    for (const algorithm of [-7, -257] as const) {
      const passkey = await softPasskey(algorithm);
      expect(await verifyRegistration(await registrationOf(passkey, CHALLENGE), expected)).toEqual({ signCount: 0 });
    }
  });

  it('turns away what was not made for this challenge, origin or kind of request', async () => {
    const passkey = await softPasskey();
    const made = await registrationOf(passkey, CHALLENGE);
    const withClientData = (data: Uint8Array) => ({ ...made, clientDataJSON: base64url(data) });

    for (const clientData of [
      clientDataOf('webauthn.get', CHALLENGE),
      clientDataOf('webauthn.create', 'another'),
      clientDataOf('webauthn.create', CHALLENGE, { origin: 'https://evil.example' }),
      clientDataOf('webauthn.create', CHALLENGE, { crossOrigin: true }),
    ]) {
      expect(await verifyRegistration(withClientData(clientData), expected)).toBe('client-data');
    }
  });

  it('turns away authenticator data that is short, for another site, or without the new credential', async () => {
    const passkey = await softPasskey();
    const made = await registrationOf(passkey, CHALLENGE);
    for (const data of [
      new Uint8Array(36),
      await authenticatorDataOf({ rpId: 'evil.example', credentialId: passkey.rawId }),
      await authenticatorDataOf(),
    ]) {
      expect(await verifyRegistration({ ...made, authenticatorData: base64url(data) }, expected)).toBe(
        'authenticator-data'
      );
    }
  });

  it('turns away a passkey made without the user verified, one whose id differs, and one with a key it cannot use', async () => {
    const passkey = await softPasskey();

    expect(await verifyRegistration(await registrationOf(passkey, CHALLENGE, USER_PRESENT), expected)).toBe(
      'user-not-verified'
    );
    expect(await verifyRegistration({ ...(await registrationOf(passkey, CHALLENGE)), id: 'AAAA' }, expected)).toBe(
      'credential'
    );
    expect(await verifyRegistration({ ...(await registrationOf(passkey, CHALLENGE)), algorithm: -8 }, expected)).toBe(
      'key'
    );
    expect(
      await verifyRegistration(
        { ...(await registrationOf(passkey, CHALLENGE)), publicKey: base64url(new Uint8Array(8)) },
        expected
      )
    ).toBe('key');
  });

  it('calls what cannot be read malformed', async () => {
    const made = await registrationOf(await softPasskey(), CHALLENGE);

    expect(
      await verifyRegistration({ ...made, clientDataJSON: base64url(new TextEncoder().encode('{')) }, expected)
    ).toBe('malformed');
    expect(await verifyRegistration({ ...made, clientDataJSON: 'a' }, expected)).toBe('malformed');
  });
});

describe('verifyAssertion', () => {
  it('takes a signature over this challenge, from this origin, for this site, with the user verified', async () => {
    for (const algorithm of [-7, -257] as const) {
      const passkey = await softPasskey(algorithm);
      expect(await verifyAssertion(await assertionOf(passkey, CHALLENGE), stored(passkey), expected)).toEqual({
        signCount: 0,
      });
    }
  });

  it('turns away what was not signed for this challenge, by the user verified, for this site', async () => {
    const passkey = await softPasskey();

    expect(await verifyAssertion(await assertionOf(passkey, 'another'), stored(passkey), expected)).toBe('client-data');
    expect(
      await verifyAssertion(
        await assertionOf(passkey, CHALLENGE, { type: 'webauthn.create' }),
        stored(passkey),
        expected
      )
    ).toBe('client-data');
    expect(
      await verifyAssertion(await assertionOf(passkey, CHALLENGE, { flags: USER_PRESENT }), stored(passkey), expected)
    ).toBe('user-not-verified');
    const other = { ...(await assertionOf(passkey, CHALLENGE)) };
    other.authenticatorData = base64url(await authenticatorDataOf({ rpId: 'evil.example' }));
    expect(await verifyAssertion(other, stored(passkey), expected)).toBe('authenticator-data');
  });

  it('turns away a signature by another key, or one not in DER', async () => {
    const passkey = await softPasskey();
    const stranger = await softPasskey();

    expect(await verifyAssertion(await assertionOf(stranger, CHALLENGE), stored(passkey), expected)).toBe('signature');
    const signed = await assertionOf(passkey, CHALLENGE);
    expect(
      await verifyAssertion({ ...signed, signature: base64url(new Uint8Array(64)) }, stored(passkey), expected)
    ).toBe('signature');
  });

  it('turns away a count that does not go up, as from a copied authenticator', async () => {
    const passkey = await softPasskey();

    expect(
      await verifyAssertion(await assertionOf(passkey, CHALLENGE, { signCount: 5 }), stored(passkey, 4), expected)
    ).toEqual({ signCount: 5 });
    expect(
      await verifyAssertion(await assertionOf(passkey, CHALLENGE, { signCount: 5 }), stored(passkey, 5), expected)
    ).toBe('counter');
    expect(
      await verifyAssertion(await assertionOf(passkey, CHALLENGE, { signCount: 0 }), stored(passkey, 3), expected)
    ).toBe('counter');
  });

  it('calls what cannot be read malformed', async () => {
    const passkey = await softPasskey();
    const signed = await assertionOf(passkey, CHALLENGE);

    expect(await verifyAssertion({ ...signed, signature: 'a' }, stored(passkey), expected)).toBe('malformed');
  });
});

describe('rawSignatureOf', () => {
  const integer = (length: number, first = 1) => [0x02, length, first, ...new Array<number>(length - 1).fill(7)];
  const sequence = (...parts: number[][]) => {
    const body = parts.flat();
    return Uint8Array.from([0x30, body.length, ...body]);
  };

  it('pads short numbers, drops the zero that keeps one positive, and puts r before s', () => {
    const raw = rawSignatureOf(sequence([0x02, 33, 0, 0x80, ...new Array<number>(31).fill(1)], integer(2)));

    expect(raw?.[0]).toBe(0x80);
    expect(raw?.[31]).toBe(1);
    expect(raw?.slice(32, 62).every((byte) => byte === 0)).toBe(true);
    expect([raw?.[62], raw?.[63]]).toEqual([1, 7]);
  });

  it.each([
    ['not a sequence', Uint8Array.from([0x31, 6, ...integer(1), ...integer(1)])],
    ['a sequence of the wrong length', Uint8Array.from([0x30, 9, ...integer(1), ...integer(1)])],
    ['a part that is not an integer', sequence([0x04, 1, 1], integer(1))],
    ['an integer running past the end', sequence(integer(1), [0x02, 9, 1])],
    ['an integer too long', sequence(integer(33), integer(1))],
    ['something after s', sequence(integer(1), integer(1), [0x05, 0])],
  ])('turns away %s', (_name, der) => {
    expect(rawSignatureOf(der)).toBeNull();
  });
});
