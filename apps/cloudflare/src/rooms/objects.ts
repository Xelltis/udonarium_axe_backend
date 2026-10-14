import type { ObjectContext } from '../../contracts/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * オブジェクトの attributes。Axe の ObjectNode（カード、チャットの発言、タブ、データ要素など）は
 * SyncVar を syncData.attributes に置く（decorator.ts）。PeerCursor のような ObjectNode でないものは
 * syncData の直下に置くので、これは空になる
 */
export const attributesOf = (context: ObjectContext): Record<string, unknown> =>
  isRecord(context.syncData.attributes) ? context.syncData.attributes : {};

/** attributes の一部を替えた写し。元は変えない */
export const withAttributes = (
  context: ObjectContext,
  changes: Record<string, unknown>,
): ObjectContext => ({
  ...context,
  syncData: { ...context.syncData, attributes: { ...attributesOf(context), ...changes } },
});
