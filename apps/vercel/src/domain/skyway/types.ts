import type { AppScope, ChannelScope } from '@skyway-sdk/token';

import type { SkywayConfig } from '../../config/types.js';

export interface IssueTokenInput {
  channelName: string;
  peerId: string;
  jti?: string;
  iat?: number;
}

export interface IssueTokenDeps {
  config: SkywayConfig;
  uuid: () => string;
  now: () => number;
  hmacSHA256: (message: string, secret: string) => Promise<ArrayBuffer>;
  encode: (input: string | ArrayBuffer) => string;
}

export interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

export interface JwtPayloadInput {
  appId: string;
  scopes: ChannelScope[];
  jti: string;
  iat: number;
  ttlSeconds: number;
}

export interface JwtPayload {
  jti: string;
  iat: number;
  exp: number;
  version: number;
  scope: { app: AppScope };
}
