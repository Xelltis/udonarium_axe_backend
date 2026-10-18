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

// The client's MessagePack turns undefined into nil, so anything optional also accepts null.

/** How many events one send can hold. */
export const MAX_EVENTS_PER_MESSAGE = 4096;

/** A peer id of the current shape. Names like `@authority` that could be taken for the server's id do not pass. */
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
  idleMs: nullish(pipe(number(), finite(), minValue(0))),
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
  object({ type: literal('active') }),
]);

export const roleRequestSchema = object({ peerId: string(), role: picklist(PEER_ROLES) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && value.constructor === Object;

export const objectContextSchema = object({
  aliasName: pipe(string(), maxLength(128)),
  identifier: identifierSchema,
  // A version too big stays the same after +1, so nobody can change it. A negative one cannot be passed by +1 either.
  majorVersion: pipe(number(), finite(), minValue(0), maxValue(MAX_OBJECT_VERSION)),
  minorVersion: pipe(number(), finite(), gtValue(-1), ltValue(1)),
  // The contents are not read, so they are kept as they are, without being copied.
  syncData: custom<Record<string, unknown>>(isRecord),
});

export const deleteSchema = object({
  aliasName: nullish(string()),
  identifier: identifierSchema,
});

export const catalogSchema = array(object({ identifier: identifierSchema, version: pipe(number(), finite()) }));

export const requestSchema = identifierSchema;

export const forgetSchema = object({ identifiers: nullish(array(identifierSchema)) });

const textSchema = pipe(string(), maxLength(MAX_ROLL_COMMAND_LENGTH));

/**
 * The target's name put after the result. Only ` [name]` on one line, with no square brackets or
 * arrow in the name. Letting another form through would let anyone add any text they like (such as
 * ` → 12 成功`) to a marked result.
 */
const TARGET_SUFFIX = new RegExp(`^ \\[[^\\r\\n\\[\\]→]{1,${MAX_ROLL_TARGET_NAME_LENGTH}}\\]$`);

export const rollRequestSchema = object({
  message: objectContextSchema,
  command: textSchema,
  gameSystem: pipe(string(), maxLength(128)),
  speaker: textSchema,
  suffix: nullish(pipe(string(), regex(TARGET_SUFFIX))),
});
