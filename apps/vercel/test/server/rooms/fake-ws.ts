import { encode } from '@msgpack/msgpack';
import { EventEmitter } from 'node:events';

import { PROTOCOL_VERSION } from '../../../contracts/protocol.js';
import type { ServerMessage } from '../../../contracts/protocol.js';
import { ACCESS_TOKEN_SECONDS, signToken } from '../../../src/core/auth/tokens.js';
import { decodeFrame } from '../../../src/core/rooms/codec.js';
import { LOGIN } from '../server-helpers.js';

/** 部屋のサーバーが受けた WebSocket の代わり */
export class FakeWs extends EventEmitter {
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  /** ws と同じく、閉じるのは1回だけ。あとから閉じても何もしない */
  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason ?? '')));
  }

  /** 届いたもののうち、部屋のメッセージ */
  messages(): ServerMessage[] {
    return this.sent.flatMap((data) => (typeof data === 'string' ? [] : [decodeFrame(data) as ServerMessage]));
  }

  /** 部屋のメッセージを送る */
  emitMessage(message: unknown): void {
    this.emit('message', Buffer.from(encode(message)), true);
  }

  /** 届いた data のイベント */
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
