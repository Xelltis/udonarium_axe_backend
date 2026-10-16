import { createHmac, timingSafeEqual } from 'node:crypto';
import { literal, number, object, optional, picklist, safeParse, string } from 'valibot';
import type { GenericSchema, InferOutput } from 'valibot';

import { PEER_ROLES } from '../../../contracts/protocol.js';

// 署名したトークン（JWT、HS256）。部屋の Durable Object が hello を受けたその場で確かめられるよう、
// 署名も検証も同期で行う（非同期にすると、確かめているあいだに同じ接続のメッセージが割り込む）。

/** アクセストークンが使える秒数 */
export const ACCESS_TOKEN_SECONDS = 15 * 60;
/** 招待が使える秒数 */
export const INVITE_SECONDS = 30 * 24 * 60 * 60;
/** ログインを始めてから、Discord から戻ってくるまでに許す秒数 */
export const LOGIN_STATE_SECONDS = 10 * 60;
/**
 * 部屋のアセットを読み書きするトークンが使える秒数。部屋を抜けた人が読めるのは、長くてもこのあいだだけ。
 * 部屋にいるあいだは、切れる前に部屋のサーバーが渡し直す
 */
export const ASSET_TOKEN_SECONDS = 15 * 60;
/** 置き場所へ直接上げるときの、上げてから知らせるまでに許す秒数 */
export const UPLOAD_TICKET_SECONDS = 15 * 60;

const encoder = new TextEncoder();

export const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

/** 頭はいつも同じ。違うものは読まないので、alg を書き換えて通そうとするものも通らない */
const HEADER = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

const nowSeconds = () => Math.floor(Date.now() / 1000);

const hmac = (body: string, secret: string): Uint8Array =>
  createHmac('sha256', secret).update(body).digest();

/** 種類（aud）ごとの中身。種類の違うトークンを取り違えて受けないよう、aud まで確かめる */
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
    /** 出した GM のユーザー ID。GM の招待は、その人がいまも GM のときだけ効く。前の形の招待には無い */
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
    /** 席のユーザー ID。置くときに、その人がいまも置ける役割かを部屋に尋ねる */
    uid: string(),
    exp: number(),
  }),
  /**
   * 置き場所へ直接上げる約束。上げる先を渡すときに出し、上げ終えた知らせで受ける。部屋のサーバーは
   * 何も覚えておかず、これだけで、だれが何をどこへ上げたかを確かめる
   */
  upload: object({
    aud: literal('upload'),
    room: string(),
    /** アセットの ID（中身の SHA-256） */
    id: string(),
    uid: string(),
    /** 上げると言ったバイト数 */
    size: number(),
    name: string(),
    /** 仮置きの場所 */
    path: string(),
    exp: number(),
  }),
} satisfies Record<string, GenericSchema>;

type Audience = keyof typeof claimSchemas;
export type Claims<A extends Audience> = InferOutput<(typeof claimSchemas)[A]>;

/** 署名する。exp は今から seconds 秒後 */
export const signToken = <A extends Audience>(
  claims: Omit<Claims<A>, 'exp'>,
  seconds: number,
  secret: string,
): string => {
  const payload = base64url(
    encoder.encode(JSON.stringify({ ...claims, exp: nowSeconds() + seconds })),
  );
  const body = `${HEADER}.${payload}`;
  return `${body}.${base64url(hmac(body, secret))}`;
};

/**
 * 署名と期限と種類を確かめて、中身を返す。どれかが合わなければ null。
 * 鍵が空なら何も通さない。空の鍵の署名は、だれにでも作れる
 */
export const readToken = <A extends Audience>(
  token: string,
  audience: A,
  secret: string,
): Claims<A> | null => {
  if (!secret) return null;
  const [header, payload, signature, ...rest] = token.split('.');
  if (header !== HEADER || rest.length > 0) return null;
  try {
    const expected = hmac(`${header}.${payload}`, secret);
    const given = fromBase64url(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = safeParse(
      claimSchemas[audience],
      JSON.parse(new TextDecoder().decode(fromBase64url(payload))),
    );
    return parsed.success && parsed.output.exp > nowSeconds() ? (parsed.output as Claims<A>) : null;
  } catch {
    return null;
  }
};
