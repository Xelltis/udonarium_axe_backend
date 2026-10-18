import type { AssetKind } from './sniff.js';

const MEGA_BYTE = 1024 * 1024;

/** The limit for each kind, kept the same as the limits the client reads up to (file-archiver.ts). */
export const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  image: 2 * MEGA_BYTE,
  audio: 10 * MEGA_BYTE,
};

export const MAX_ANY_BYTES = Math.max(...Object.values(MAX_BYTES));
