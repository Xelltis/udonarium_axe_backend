import { integer, minValue, number, object, pipe, string, transform } from 'valibot';

export const envSchema = object({
  ACCESS_CONTROL_ALLOW_ORIGIN: string(),
  ASSET_RETENTION_DAYS: pipe(string(), transform(Number), number(), integer(), minValue(1)),
  ROOM_RETENTION_HOURS: pipe(string(), transform(Number), number(), integer(), minValue(1)),
});
