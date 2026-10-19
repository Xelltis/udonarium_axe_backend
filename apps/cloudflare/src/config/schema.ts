import { integer, minValue, number, object, pipe, string, transform } from 'valibot';

import { adminEntries, adminIdsValid, adminStorageAlertValid, adminWebhookValid } from '../core/config/admin';
import { loginComplete, loginEntries, sessionSecretLongEnough } from '../core/config/login';
import { roomStorageEntries, roomStorageValid } from '../core/config/rooms';

export const envSchema = pipe(
  object({
    ACCESS_CONTROL_ALLOW_ORIGIN: string(),
    ROOM_RETENTION_HOURS: pipe(string(), transform(Number), number(), integer(), minValue(1)),
    ...loginEntries,
    ...adminEntries,
    ...roomStorageEntries,
  }),
  loginComplete(),
  sessionSecretLongEnough(),
  adminIdsValid(),
  adminWebhookValid(),
  adminStorageAlertValid(),
  roomStorageValid()
);
