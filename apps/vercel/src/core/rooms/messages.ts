import {
  array,
  custom,
  finite,
  gtValue,
  literal,
  ltValue,
  maxLength,
  maxValue,
  minLength,
  minValue,
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

import {
  MAX_OBJECT_VERSION,
  MAX_PASSWORD_LENGTH,
  MAX_ROLL_COMMAND_LENGTH,
  MAX_ROLL_TARGET_NAME_LENGTH,
  PEER_ROLES,
} from '../../../contracts/protocol.js';

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
  object({ type: literal('auth'), accessToken: string() }),
  object({ type: literal('asset-token') }),
]);

export const roleRequestSchema = object({ peerId: string(), role: picklist(PEER_ROLES) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && value.constructor === Object;

export const objectContextSchema = object({
  aliasName: pipe(string(), maxLength(128)),
  identifier: identifierSchema,
  // 大きすぎる版は、あとから +1 しても変わらず、だれも書き換えられなくなる。負の版も +1 で追い越せない
  majorVersion: pipe(number(), finite(), minValue(0), maxValue(MAX_OBJECT_VERSION)),
  minorVersion: pipe(number(), finite(), gtValue(-1), ltValue(1)),
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

const textSchema = pipe(string(), maxLength(MAX_ROLL_COMMAND_LENGTH));

/**
 * 結果の後ろに付ける対象の名前。1行の ` [名前]` だけで、名前には角括弧と矢印を含めない。違う形を通すと、
 * 印の付いた結果に好きな文（` → 12 成功` など）を足せてしまう
 */
const TARGET_SUFFIX = new RegExp(`^ \\[[^\\r\\n\\[\\]→]{1,${MAX_ROLL_TARGET_NAME_LENGTH}}\\]$`);

export const rollRequestSchema = object({
  message: objectContextSchema,
  command: textSchema,
  gameSystem: pipe(string(), maxLength(128)),
  speaker: textSchema,
  suffix: nullish(pipe(string(), regex(TARGET_SUFFIX))),
});
