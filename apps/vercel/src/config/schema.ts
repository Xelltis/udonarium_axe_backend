import {
  integer,
  minLength,
  minValue,
  maxValue,
  number,
  object,
  optional,
  pipe,
  string,
  transform,
  union,
} from 'valibot';

const numericInput = pipe(union([string(), number()]), transform(Number), number(), integer());

const DEFAULT_LOBBY_SIZE = 3;
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const MAX_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;
const MIN_TOKEN_TTL_SECONDS = 60;

export const envSchema = object({
  SKYWAY_APP_ID: pipe(string(), minLength(1)),
  SKYWAY_SECRET: pipe(string(), minLength(1)),
  ACCESS_CONTROL_ALLOW_ORIGIN: string(),
  SKYWAY_UDONARIUM_LOBBY_SIZE: optional(pipe(numericInput, minValue(1)), DEFAULT_LOBBY_SIZE),
  SKYWAY_TOKEN_TTL_SECONDS: optional(
    pipe(numericInput, minValue(MIN_TOKEN_TTL_SECONDS), maxValue(MAX_TOKEN_TTL_SECONDS)),
    DEFAULT_TOKEN_TTL_SECONDS,
  ),
  ENVIRONMENT: optional(string()),
});
