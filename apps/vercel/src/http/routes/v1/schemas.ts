import { check, maxBytes, minLength, number, object, pipe, regex, string, value } from 'valibot';

import { LOBBY_CHANNEL_PREFIX } from '../../../domain/skyway/scopes.js';

/** The most bytes a channelName or peerId may have (the same as the PHP version). */
const MAX_SCOPE_NAME_BYTES = 200;

/**
 * A name put in a SkyWay scope. SkyWay reads "*" in a name as a wildcard that matches any string,
 * and "\" as its escape, so taking them in would widen what the issued token allows past the room
 * and members it was meant for.
 */
const scopeName = pipe(string(), minLength(1), maxBytes(MAX_SCOPE_NAME_BYTES), regex(/^[^*\\]*$/));

export const skywayTokenRequestSchema = object({
  formatVersion: pipe(number(), value(1)),
  channelName: pipe(
    scopeName,
    check((name) => !name.startsWith(LOBBY_CHANNEL_PREFIX))
  ),
  peerId: scopeName,
});
