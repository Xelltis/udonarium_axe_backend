import { integer, minValue, number, object, pipe, string, transform } from 'valibot';

import { loginComplete, loginEntries, sessionSecretLongEnough } from '../core/config/login';

export const envSchema = pipe(
  object({
    ACCESS_CONTROL_ALLOW_ORIGIN: string(),
    ROOM_RETENTION_HOURS: pipe(string(), transform(Number), number(), integer(), minValue(1)),
    ...loginEntries,
  }),
  loginComplete(),
  sessionSecretLongEnough(),
);
