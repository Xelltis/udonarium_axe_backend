import { check, maxBytes, minLength, number, object, pipe, regex, string, value } from 'valibot';

import { LOBBY_CHANNEL_PREFIX } from '../../../domain/skyway/scopes.js';

/** channelName と peerId の最大バイト数（PHP 版と同じ） */
const MAX_SCOPE_NAME_BYTES = 200;

/**
 * SkyWay のスコープに入れる名前。SkyWay は name の "*" を任意の文字列に一致するワイルドカード、
 * "\" をその打ち消しとして解釈するので、これらを受け付けると、発行したトークンの権限が
 * 意図した部屋やメンバーを越えて広がる。
 */
const scopeName = pipe(string(), minLength(1), maxBytes(MAX_SCOPE_NAME_BYTES), regex(/^[^*\\]*$/));

export const skywayTokenRequestSchema = object({
  formatVersion: pipe(number(), value(1)),
  channelName: pipe(
    scopeName,
    check((name) => !name.startsWith(LOBBY_CHANNEL_PREFIX)),
  ),
  peerId: scopeName,
});
