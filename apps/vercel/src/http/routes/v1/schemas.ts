import { number, object, pipe, string, value } from 'valibot';

export const skywayTokenRequestSchema = object({
  formatVersion: pipe(number(), value(1)),
  channelName: string(),
  peerId: string(),
});
