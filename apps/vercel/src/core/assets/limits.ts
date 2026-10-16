import type { AssetKind } from './sniff.js';

const MEGA_BYTE = 1024 * 1024;

/** 種類ごとの上限。クライアントが読み込む上限（file-archiver.ts）と揃える */
export const MAX_BYTES: Readonly<Record<AssetKind, number>> = {
  image: 2 * MEGA_BYTE,
  audio: 10 * MEGA_BYTE,
};

export const MAX_ANY_BYTES = Math.max(...Object.values(MAX_BYTES));
