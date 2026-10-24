import type { SkywayConfig } from '../../config/types.js';

/**
 * The scope of a SkyWay token (version 2), as far as this server fills it in. The actions are the
 * ones SkyWay names for each resource; it takes more than is written here (an id in place of a
 * name, sfuBots, analytics), which this server does not give out.
 */
export interface AppScope {
  id: string;
  turn: boolean;
  actions: 'read'[];
  channels: ChannelScope[];
}

export interface ChannelScope {
  name: string;
  actions: ('write' | 'read' | 'create' | 'delete' | 'updateMetadata')[];
  members: MemberScope[];
}

export interface MemberScope {
  name: string;
  actions: ('write' | 'create' | 'delete' | 'updateMetadata' | 'signal')[];
  publication: { actions: ('write' | 'create' | 'delete' | 'updateMetadata' | 'enable' | 'disable')[] };
  subscription: { actions: ('write' | 'create' | 'delete')[] };
}

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
