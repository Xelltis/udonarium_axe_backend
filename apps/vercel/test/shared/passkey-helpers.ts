import { base64url } from '../../src/core/auth/tokens.js';

// An authenticator in software, for the tests: it makes passkeys with WebCrypto and answers
// challenges as a browser and a device would.

export const SITE = { origin: 'https://backend.example', rpId: 'backend.example' };

const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));

export const USER_PRESENT = 0x01;
export const USER_VERIFIED = 0x04;
export const ATTESTED_CREDENTIAL = 0x40;

/** authenticatorData: the site's hash, the flags, the count, and (when made) the credential's id. */
export const authenticatorDataOf = async (
  options: { rpId?: string; flags?: number; signCount?: number; credentialId?: Uint8Array } = {}
) => {
  const { rpId = SITE.rpId, flags = USER_PRESENT | USER_VERIFIED, signCount = 0, credentialId } = options;
  const head = new Uint8Array(37);
  head.set(await sha256(new TextEncoder().encode(rpId)));
  head[32] = credentialId ? flags | ATTESTED_CREDENTIAL : flags;
  new DataView(head.buffer).setUint32(33, signCount);
  if (!credentialId) return head;
  const attested = new Uint8Array(18 + credentialId.length);
  attested[16] = credentialId.length >> 8;
  attested[17] = credentialId.length & 0xff;
  attested.set(credentialId, 18);
  const all = new Uint8Array(head.length + attested.length);
  all.set(head);
  all.set(attested, head.length);
  return all;
};

export const clientDataOf = (type: string, challenge: string, extra: Record<string, unknown> = {}) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin: SITE.origin, ...extra }));

/** An ECDSA signature in WebCrypto's form (r and s) written as DER, as an authenticator gives it. */
export const derOf = (raw: Uint8Array): Uint8Array => {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.subarray(start);
    const body = trimmed[0] & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
    return Uint8Array.of(0x02, body.length, ...body);
  };
  const r = integer(raw.subarray(0, 32));
  const s = integer(raw.subarray(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
};

export interface SoftPasskey {
  id: string;
  rawId: Uint8Array;
  algorithm: -7 | -257;
  publicKey: string;
  /** How many times it has signed. */
  signCount: number;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** Makes a passkey of the kind asked for (ES256 or RS256). */
export const softPasskey = async (algorithm: -7 | -257 = -7): Promise<SoftPasskey> => {
  const pair = (
    algorithm === -7
      ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
      : await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256',
          },
          true,
          ['sign', 'verify']
        )
  ) as CryptoKeyPair;
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  return {
    id: base64url(rawId),
    rawId,
    algorithm,
    publicKey: base64url(new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer)),
    signCount: 0,
    sign: async (data) => {
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          algorithm === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
          pair.privateKey,
          data as Uint8Array<ArrayBuffer>
        )
      );
      return algorithm === -7 ? derOf(signature) : signature;
    },
  };
};

/** What the browser hands back when the passkey is made for the challenge. */
export const registrationOf = async (passkey: SoftPasskey, challenge: string, flags?: number) => ({
  id: passkey.id,
  clientDataJSON: base64url(clientDataOf('webauthn.create', challenge)),
  authenticatorData: base64url(await authenticatorDataOf({ credentialId: passkey.rawId, flags })),
  publicKey: passkey.publicKey,
  algorithm: passkey.algorithm,
});

/** What the browser hands back when the passkey signs the challenge. Each signature counts up. */
export const assertionOf = async (
  passkey: SoftPasskey,
  challenge: string,
  options: { flags?: number; signCount?: number; type?: string } = {}
) => {
  const clientData = clientDataOf(options.type ?? 'webauthn.get', challenge);
  passkey.signCount = options.signCount ?? passkey.signCount;
  const authenticatorData = await authenticatorDataOf({ flags: options.flags, signCount: passkey.signCount });
  const signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData);
  signed.set(await sha256(clientData), authenticatorData.length);
  return {
    id: passkey.id,
    clientDataJSON: base64url(clientData),
    authenticatorData: base64url(authenticatorData),
    signature: base64url(await passkey.sign(signed)),
  };
};
