import type { JwtHeader, JwtPayload, JwtPayloadInput } from './types.js';

export const buildJwtHeader = (): JwtHeader => ({ alg: 'HS256', typ: 'JWT' });

export const buildJwtPayload = (input: JwtPayloadInput): JwtPayload => ({
  jti: input.jti,
  iat: input.iat,
  exp: input.iat + input.ttlSeconds,
  version: 2,
  scope: {
    app: {
      id: input.appId,
      turn: true,
      actions: ['read'],
      channels: input.scopes,
    },
  },
});

export interface SignJwtDeps {
  hmacSHA256: (message: string, secret: string) => Promise<ArrayBuffer>;
  encode: (input: string | ArrayBuffer) => string;
}

export const signJwt = async (
  header: JwtHeader,
  payload: JwtPayload,
  secret: string,
  deps: SignJwtDeps,
): Promise<string> => {
  const encodedHeader = deps.encode(JSON.stringify(header));
  const encodedPayload = deps.encode(JSON.stringify(payload));
  const signature = deps.encode(
    await deps.hmacSHA256(`${encodedHeader}.${encodedPayload}`, secret),
  );
  return `${encodedHeader}.${encodedPayload}.${signature}`;
};
