import { PROTOCOL_VERSION } from '../../../contracts/protocol.js';
import type { ErrorCode } from '../../../contracts/protocol.js';
import { encodeFrame } from './codec.js';

/**
 * What is sent when refusing. Used when refusing without going through the room's relay
 * (RoomEngine), such as when there is nowhere to keep the room.
 */
export const refusalFrame = (code: ErrorCode): Uint8Array =>
  encodeFrame({ type: 'error', code, protocolVersion: PROTOCOL_VERSION });
