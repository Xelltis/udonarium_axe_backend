import { createHmac } from 'node:crypto';
import {
  integer,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  optional,
  pipe,
  safeParse,
  string,
  summarize,
  transform,
  union,
} from 'valibot';

import { base64url } from '../core/auth/tokens';

/**
 * The start of a lobby channel name. The lobby scope does not allow sending or receiving data, so
 * even when a name that starts with this is asked for as a room, the room scope (which allows
 * sending and receiving) is not given out.
 */
export const LOBBY_CHANNEL_PREFIX = 'udonarium-lobby-';

const DEFAULT_LOBBY_SIZE = 3;
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const MIN_TOKEN_TTL_SECONDS = 60;

/** The SkyWay app the tokens are issued for, as the PHP and Vercel versions take it. */
export interface SkywayConfig {
  appId: string;
  secret: string;
  /** How many lobby channels the room list is split across. */
  lobbySize: number;
  tokenTtlSeconds: number;
}

const numericInput = pipe(union([string(), number()]), transform(Number), number(), integer());

const skywaySchema = object({
  SKYWAY_APP_ID: pipe(string(), minLength(1)),
  SKYWAY_SECRET: pipe(string(), minLength(1)),
  SKYWAY_UDONARIUM_LOBBY_SIZE: optional(pipe(numericInput, minValue(1)), DEFAULT_LOBBY_SIZE),
  SKYWAY_TOKEN_TTL_SECONDS: optional(
    pipe(numericInput, minValue(MIN_TOKEN_TTL_SECONDS), maxValue(MAX_TOKEN_TTL_SECONDS)),
    DEFAULT_TOKEN_TTL_SECONDS
  ),
});

/**
 * The SkyWay app this Worker issues tokens for, or why it issues none: no app id or secret set, as
 * on a Worker that only keeps rooms, or a setting out of range.
 */
export const skywayConfigOf = (env: unknown): SkywayConfig | { problem: string } => {
  const parsed = safeParse(skywaySchema, env);
  if (!parsed.success) return { problem: summarize(parsed.issues) };
  return {
    appId: parsed.output.SKYWAY_APP_ID,
    secret: parsed.output.SKYWAY_SECRET,
    lobbySize: parsed.output.SKYWAY_UDONARIUM_LOBBY_SIZE,
    tokenTtlSeconds: parsed.output.SKYWAY_TOKEN_TTL_SECONDS,
  };
};

interface ChannelMember {
  name: string;
  actions: string[];
  publication: { actions: string[] };
  subscription: { actions: string[] };
}

interface ChannelScope {
  name: string;
  actions: string[];
  members: ChannelMember[];
}

/** The lobby channels, where the peer may only be seen, not send or receive data. */
const lobbyScope = (peerId: string, lobbySize: number): ChannelScope => ({
  name: `${LOBBY_CHANNEL_PREFIX}*-of-${lobbySize}`,
  actions: ['read', 'create'],
  members: [{ name: peerId, actions: ['write'], publication: { actions: [] }, subscription: { actions: [] } }],
});

/** The room channel, where the peer sends and receives, and the others only signal. */
const roomScope = (channelName: string, peerId: string): ChannelScope => ({
  name: channelName,
  actions: ['read', 'create'],
  members: [
    {
      name: peerId,
      actions: ['write'],
      publication: { actions: ['write'] },
      subscription: { actions: ['write'] },
    },
    { name: '*', actions: ['signal'], publication: { actions: [] }, subscription: { actions: [] } },
  ],
});

const encoder = new TextEncoder();
const encode = (text: string): string => base64url(encoder.encode(text));

/**
 * A SkyWay token (HS256) that lets one peer into the lobby channels and one room channel, the same
 * as the PHP and Vercel versions issue.
 */
export const issueSkywayToken = (
  config: SkywayConfig,
  request: { channelName: string; peerId: string },
  iat: number = Math.floor(Date.now() / 1000),
  jti: string = crypto.randomUUID()
): string => {
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encode(
    JSON.stringify({
      jti,
      iat,
      exp: iat + config.tokenTtlSeconds,
      version: 2,
      scope: {
        app: {
          id: config.appId,
          turn: true,
          actions: ['read'],
          channels: [lobbyScope(request.peerId, config.lobbySize), roomScope(request.channelName, request.peerId)],
        },
      },
    })
  );
  const signature = base64url(
    new Uint8Array(createHmac('sha256', config.secret).update(`${header}.${payload}`).digest())
  );
  return `${header}.${payload}.${signature}`;
};
