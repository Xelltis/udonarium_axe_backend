import { object, string } from 'valibot';

export const envSchema = object({
  ACCESS_CONTROL_ALLOW_ORIGIN: string(),
});
