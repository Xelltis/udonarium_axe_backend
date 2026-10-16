import type { ObjectContext } from '../../../contracts/protocol.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An object's attributes. Axe's ObjectNodes (cards, chat lines, tabs, data elements and so on) keep
 * their SyncVars in syncData.attributes (decorator.ts). Something that is not an ObjectNode, like
 * PeerCursor, keeps them right under syncData, so for it this is empty.
 */
export const attributesOf = (context: ObjectContext): Record<string, unknown> =>
  isRecord(context.syncData.attributes) ? context.syncData.attributes : {};

/** A copy with some of the attributes changed. The original is left as it is. */
export const withAttributes = (context: ObjectContext, changes: Record<string, unknown>): ObjectContext => ({
  ...context,
  syncData: { ...context.syncData, attributes: { ...attributesOf(context), ...changes } },
});
