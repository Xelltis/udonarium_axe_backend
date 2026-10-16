import { PROTOCOL_VERSION } from '../../../contracts/protocol.js';
import type { ErrorCode } from '../../../contracts/protocol.js';
import { encodeFrame } from './codec.js';

/** 断るときに送るもの。部屋の中継（RoomEngine）を通さずに断るとき（部屋を置くところが無いときなど）に使う */
export const refusalFrame = (code: ErrorCode): Uint8Array =>
  encodeFrame({ type: 'error', code, protocolVersion: PROTOCOL_VERSION });
