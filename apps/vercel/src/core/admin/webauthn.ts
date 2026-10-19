import { fromBase64url } from '../auth/tokens.js';

// Passkeys (WebAuthn) for the operator's dashboard: checking what the browser hands back when a
// passkey is made, and when it signs in. Only what the dashboard needs is checked: no attestation
// (who made the authenticator is not asked), and keys of the two kinds that passkeys come with.
//
// The browser gives the new public key itself (getPublicKey, as SubjectPublicKeyInfo), so the COSE
// key inside the attestation is not read. What makes a passkey safe is checked when it signs in: the
// signature, over this challenge, from this origin, for this site, with the user verified.

/** The kinds of key a passkey may have: ES256 (ECDSA on P-256) and RS256 (RSA, PKCS #1 v1.5). */
export const PASSKEY_ALGORITHMS = [-7, -257] as const;
export type PasskeyAlgorithm = (typeof PASSKEY_ALGORITHMS)[number];

/** A passkey an operator registered. */
export interface Passkey {
  /** The credential id (base64url). */
  id: string;
  /** The Discord user id of the operator it belongs to. */
  discordId: string;
  /** Its public key, as SubjectPublicKeyInfo (base64url). */
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  /** The name the operator gave it, to tell their devices apart. */
  name: string;
  /** When it was registered, and last used (Unix milliseconds; null before it is used). */
  createdAt: number;
  usedAt: number | null;
  /** How many times the authenticator says it has signed. 0 for one that does not count. */
  signCount: number;
}

/** What the browser's answer has to be for. */
export interface Expected {
  /** The challenge the server gave (base64url). */
  challenge: string;
  /** The dashboard's origin (https://backend.example.com). */
  origin: string;
  /** The site the passkey belongs to: the dashboard's host name. */
  rpId: string;
}

/** What the browser hands back when a passkey is made (each part base64url). */
export interface Registration {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKey: string;
  algorithm: number;
}

/** What the browser hands back when a passkey signs (each part base64url). */
export interface Assertion {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Why a passkey's answer is not taken. */
export type PasskeyFailure =
  | 'malformed'
  | 'client-data'
  | 'authenticator-data'
  | 'user-not-verified'
  | 'credential'
  | 'key'
  | 'signature'
  | 'counter';

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

export const isPasskeyAlgorithm = (value: number): value is PasskeyAlgorithm =>
  (PASSKEY_ALGORITHMS as readonly number[]).includes(value);

/** Whether clientDataJSON says the page did what was asked, for this challenge, on this origin. */
const clientDataFits = (bytes: Uint8Array, type: string, expected: Expected): boolean => {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  return (
    data.type === type &&
    data.challenge === expected.challenge &&
    data.origin === expected.origin &&
    data.crossOrigin !== true
  );
};

/**
 * The flags and the count in authenticatorData, once it is for the expected site. Null when it is too
 * short or for another site.
 */
const authenticatorDataOf = async (
  bytes: Uint8Array,
  rpId: string
): Promise<{ flags: number; signCount: number } | null> => {
  if (bytes.length < 37) return null;
  if (!sameBytes(bytes.subarray(0, 32), await sha256(new TextEncoder().encode(rpId)))) return null;
  return { flags: bytes[32], signCount: new DataView(bytes.buffer, bytes.byteOffset).getUint32(33) };
};

const verified = (flags: number): boolean => (flags & USER_PRESENT) !== 0 && (flags & USER_VERIFIED) !== 0;

const importKey = (spki: Uint8Array, algorithm: PasskeyAlgorithm): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'spki',
    spki as Uint8Array<ArrayBuffer>,
    algorithm === -7 ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

/** One INTEGER of a DER signature, as 32 bytes, and where the next part begins. Null when it is not one. */
const integerAt = (der: Uint8Array, at: number): { value: Uint8Array; next: number } | null => {
  const length = der[at + 1];
  const next = at + 2 + length;
  if (der[at] !== 0x02 || next > der.length) return null;
  let value = der.subarray(at + 2, next);
  // A leading zero only keeps the number from reading as negative.
  while (value.length > 32 && value[0] === 0) value = value.subarray(1);
  if (value.length > 32) return null;
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next };
};

/**
 * An ECDSA signature as WebAuthn gives it (DER: a SEQUENCE of r and s) in the form WebCrypto takes
 * (r and s, 32 bytes each). Null when it is not in that form.
 */
export const rawSignatureOf = (der: Uint8Array): Uint8Array | null => {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const r = integerAt(der, 2);
  const s = r && integerAt(der, r.next);
  if (!r || !s || s.next !== der.length) return null;
  const raw = new Uint8Array(64);
  raw.set(r.value);
  raw.set(s.value, 32);
  return raw;
};

/**
 * Checks a passkey the browser has just made. The signature count it starts at when it is taken, or
 * why it is not.
 */
export const verifyRegistration = async (
  registration: Registration,
  expected: Expected
): Promise<{ signCount: number } | PasskeyFailure> => {
  try {
    if (!clientDataFits(fromBase64url(registration.clientDataJSON), 'webauthn.create', expected)) {
      return 'client-data';
    }
    const authenticatorData = fromBase64url(registration.authenticatorData);
    const read = await authenticatorDataOf(authenticatorData, expected.rpId);
    if (!read || (read.flags & ATTESTED_CREDENTIAL) === 0) return 'authenticator-data';
    if (!verified(read.flags)) return 'user-not-verified';
    // The credential the authenticator made follows its AAGUID (16 bytes) and the id's length (2).
    const idLength = (authenticatorData[53] << 8) | authenticatorData[54];
    if (!sameBytes(authenticatorData.subarray(55, 55 + idLength), fromBase64url(registration.id))) {
      return 'credential';
    }
    if (!isPasskeyAlgorithm(registration.algorithm)) return 'key';
    const usable = await importKey(fromBase64url(registration.publicKey), registration.algorithm).then(
      () => true,
      () => false
    );
    return usable ? { signCount: read.signCount } : 'key';
  } catch {
    return 'malformed';
  }
};

/**
 * Checks a passkey's signature. The new signature count when it is good, or why it is not. An
 * authenticator that counts its signatures has to count up; one that went back may have been copied.
 */
export const verifyAssertion = async (
  assertion: Assertion,
  passkey: Passkey,
  expected: Expected
): Promise<{ signCount: number } | PasskeyFailure> => {
  try {
    const clientData = fromBase64url(assertion.clientDataJSON);
    if (!clientDataFits(clientData, 'webauthn.get', expected)) return 'client-data';
    const authenticatorData = fromBase64url(assertion.authenticatorData);
    const read = await authenticatorDataOf(authenticatorData, expected.rpId);
    if (!read) return 'authenticator-data';
    if (!verified(read.flags)) return 'user-not-verified';
    const given = fromBase64url(assertion.signature);
    const signature = passkey.algorithm === -7 ? rawSignatureOf(given) : given;
    if (!signature) return 'signature';
    const signed = new Uint8Array(authenticatorData.length + 32);
    signed.set(authenticatorData);
    signed.set(await sha256(clientData), authenticatorData.length);
    const good = await crypto.subtle.verify(
      passkey.algorithm === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
      await importKey(fromBase64url(passkey.publicKey), passkey.algorithm),
      signature as Uint8Array<ArrayBuffer>,
      signed
    );
    if (!good) return 'signature';
    if ((read.signCount > 0 || passkey.signCount > 0) && read.signCount <= passkey.signCount) return 'counter';
    return { signCount: read.signCount };
  } catch {
    return 'malformed';
  }
};
