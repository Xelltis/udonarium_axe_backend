import { createHmac, timingSafeEqual } from 'node:crypto';
import { literal, number, object, optional, picklist, safeParse, string } from 'valibot';
import type { GenericSchema, InferOutput } from 'valibot';

import { PEER_ROLES } from '../../../contracts/protocol.js';

// Signed tokens (JWT, HS256). Signing and checking are both done synchronously, so that the room's
// Durable Object can check a token the moment it receives the hello (done asynchronously, messages
// on the same connection would cut in while it is checking).

/** How many seconds an access token can be used for. */
export const ACCESS_TOKEN_SECONDS = 15 * 60;
/** How many seconds an invite can be used for. */
export const INVITE_SECONDS = 30 * 24 * 60 * 60;
/** How many seconds are allowed from the start of a login until it comes back from Discord. */
export const LOGIN_STATE_SECONDS = 10 * 60;
/**
 * How many seconds a token for reading and writing the room's assets can be used for. Someone who
 * has left the room can read them for this long at most.
 * While someone is in the room, the room server hands out a new one before it runs out.
 */
export const ASSET_TOKEN_SECONDS = 15 * 60;
/** For an upload straight to the store, how many seconds are allowed from the upload until it is reported. */
export const UPLOAD_TICKET_SECONDS = 15 * 60;

const encoder = new TextEncoder();

export const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

/**
 * The header is always the same. No other is read, so a token that changes alg to get through does
 * not get through.
 */
const HEADER = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

const nowSeconds = () => Math.floor(Date.now() / 1000);

const hmac = (body: string, secret: string): Uint8Array => createHmac('sha256', secret).update(body).digest();

/**
 * The contents for each kind (aud). The aud is checked too, so that a token of another kind is not
 * taken by mistake.
 */
const claimSchemas = {
  access: object({
    aud: literal('access'),
    sub: string(),
    uid: string(),
    name: string(),
    exp: number(),
  }),
  invite: object({
    aud: literal('invite'),
    room: string(),
    role: picklist(PEER_ROLES),
    /**
     * The user id of the GM who made it. An invite to be GM works only while that person is still
     * GM. Invites in the older form do not have it.
     */
    by: optional(string()),
    exp: number(),
  }),
  login: object({
    aud: literal('login'),
    redirect: string(),
    challenge: string(),
    exp: number(),
  }),
  asset: object({
    aud: literal('asset'),
    room: string(),
    role: picklist(PEER_ROLES),
    /**
     * The seat's user id. On storing, the room is asked whether that person still has a role that
     * may store.
     */
    uid: string(),
    exp: number(),
  }),
  /**
   * The ticket for an upload straight to the store. It is given out with the place to upload to,
   * and comes back with the word that the upload is done. The room server remembers nothing, and
   * checks from this alone who uploaded what, and where.
   */
  upload: object({
    aud: literal('upload'),
    room: string(),
    /** The asset's id (the SHA-256 of its contents). */
    id: string(),
    uid: string(),
    /** How many bytes the uploader said it would upload. */
    size: number(),
    name: string(),
    /** Where the upload waits. */
    path: string(),
    exp: number(),
  }),
} satisfies Record<string, GenericSchema>;

type Audience = keyof typeof claimSchemas;
export type Claims<A extends Audience> = InferOutput<(typeof claimSchemas)[A]>;

/** Signs a token. Its exp is the given number of seconds from now. */
export const signToken = <A extends Audience>(
  claims: Omit<Claims<A>, 'exp'>,
  seconds: number,
  secret: string
): string => {
  const payload = base64url(encoder.encode(JSON.stringify({ ...claims, exp: nowSeconds() + seconds })));
  const body = `${HEADER}.${payload}`;
  return `${body}.${base64url(hmac(body, secret))}`;
};

/**
 * Checks the signature, the expiry and the kind, and returns the contents. Null when any of them
 * does not match.
 * With an empty key nothing gets through. Anyone can make a signature with an empty key.
 */
export const readToken = <A extends Audience>(token: string, audience: A, secret: string): Claims<A> | null => {
  if (!secret) return null;
  const [header, payload, signature, ...rest] = token.split('.');
  if (header !== HEADER || rest.length > 0) return null;
  try {
    const expected = hmac(`${header}.${payload}`, secret);
    const given = fromBase64url(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = safeParse(claimSchemas[audience], JSON.parse(new TextDecoder().decode(fromBase64url(payload))));
    return parsed.success && parsed.output.exp > nowSeconds() ? (parsed.output as Claims<A>) : null;
  } catch {
    return null;
  }
};
