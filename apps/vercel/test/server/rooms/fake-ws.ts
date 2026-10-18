import { encode } from '@msgpack/msgpack';
import { EventEmitter } from 'node:events';

import { PROTOCOL_VERSION } from '../../../contracts/protocol.js';
import type { ServerMessage } from '../../../contracts/protocol.js';
import { ACCESS_TOKEN_SECONDS, signToken } from '../../../src/core/auth/tokens.js';
import { decodeFrame } from '../../../src/core/rooms/codec.js';
import { LOGIN } from '../server-helpers.js';

/** Stands in for a WebSocket the room server took. */
export class FakeWs extends EventEmitter {
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  /** As with ws, closes only once. Closing again later does nothing. */
  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason ?? '')));
  }

  /** The room messages among what arrived. */
  messages(): ServerMessage[] {
    return this.sent.flatMap((data) => (typeof data === 'string' ? [] : [decodeFrame(data) as ServerMessage]));
  }

  /** Sends a room message. */
  emitMessage(message: unknown): void {
    this.emit('message', Buffer.from(encode(message)), true);
  }

  /** The events in the data messages that arrived. */
  events(): { eventName: string; data: unknown; sendFrom: string }[] {
    return this.messages().flatMap((message) => (message.type === 'data' ? message.events : []));
  }

  hello(peerId: string): void {
    const userId = `user-${peerId}`;
    this.emit(
      'message',
      Buffer.from(
        encode({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          peerId,
          userId,
          accessToken: signToken<'access'>(
            { aud: 'access', sub: `discord:${peerId}`, uid: userId, name: peerId },
            ACCESS_TOKEN_SECONDS,
            LOGIN.SESSION_SECRET
          ),
        })
      ),
      true
    );
  }
}
