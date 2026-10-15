import {
  array,
  custom,
  finite,
  literal,
  maxLength,
  minLength,
  nullish,
  number,
  object,
  picklist,
  pipe,
  regex,
  string,
  unknown,
  variant,
} from 'valibot';

import { MAX_PASSWORD_LENGTH, PEER_ROLES } from '../../contracts/protocol';

// クライアントの MessagePack は undefined を nil にするので、省けるものは null も受ける

/** 1つの send に入れられるイベントの数 */
export const MAX_EVENTS_PER_MESSAGE = 4096;

/** 今と同じ形のピア ID。`@authority` のような、サーバーの ID と紛れる名前は通さない */
const peerIdSchema = pipe(string(), regex(/^[\w-]{1,64}$/));

const identifierSchema = pipe(string(), minLength(1), maxLength(256));

const eventSchema = object({
  eventName: pipe(string(), minLength(1), maxLength(128)),
  data: unknown(),
});

export const helloSchema = object({
  type: literal('hello'),
  protocolVersion: number(),
  peerId: peerIdSchema,
  userId: pipe(string(), minLength(1), maxLength(128)),
  password: nullish(pipe(string(), maxLength(MAX_PASSWORD_LENGTH))),
  accessToken: nullish(string()),
  invite: nullish(string()),
});

export const clientMessageSchema = variant('type', [
  helloSchema,
  object({
    type: literal('send'),
    to: nullish(string()),
    events: pipe(array(eventSchema), maxLength(MAX_EVENTS_PER_MESSAGE)),
  }),
  object({ type: literal('time') }),
  object({ type: literal('invite'), role: picklist(PEER_ROLES) }),
]);

export const roleRequestSchema = object({ peerId: string(), role: picklist(PEER_ROLES) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && value.constructor === Object;

export const objectContextSchema = object({
  aliasName: pipe(string(), maxLength(128)),
  identifier: identifierSchema,
  majorVersion: pipe(number(), finite()),
  minorVersion: pipe(number(), finite()),
  // 中身は読まないので、写さずにそのまま持つ
  syncData: custom<Record<string, unknown>>(isRecord),
});

export const deleteSchema = object({
  aliasName: nullish(string()),
  identifier: identifierSchema,
});

export const catalogSchema = array(
  object({ identifier: identifierSchema, version: pipe(number(), finite()) }),
);

export const requestSchema = identifierSchema;

export const forgetSchema = object({ identifiers: nullish(array(identifierSchema)) });

const textSchema = pipe(string(), maxLength(4000));

export const rollRequestSchema = object({
  message: objectContextSchema,
  command: textSchema,
  gameSystem: pipe(string(), maxLength(128)),
  speaker: textSchema,
  suffix: nullish(textSchema),
});
