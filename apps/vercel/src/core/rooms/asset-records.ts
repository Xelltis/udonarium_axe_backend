import {
  ASSET_OWNER_ALIAS,
  ASSET_OWNER_PREFIX,
  ASSET_REMOVAL_ALIAS,
  ASSET_REMOVAL_PREFIX,
  IMAGE_TAG_LOCK_ALIAS,
  IMAGE_TAG_LOCK_PREFIX,
} from '../../../contracts/protocol.js';
import type { ObjectContext } from '../../../contracts/protocol.js';
import { attributesOf } from './objects.js';

// The rules for the room's records of its pictures and sounds: who added each, which are taken out of
// the room, and which tags of pictures are kept to one person. Each is an ObjectNode of Axe's, so what
// it holds is in its attributes. None of them keeps any state.

/** The kinds of record, each with the start of the identifiers kept for it. */
const RECORD_KINDS: readonly (readonly [alias: string, prefix: string])[] = [
  [ASSET_REMOVAL_ALIAS, ASSET_REMOVAL_PREFIX],
  [ASSET_OWNER_ALIAS, ASSET_OWNER_PREFIX],
  [IMAGE_TAG_LOCK_ALIAS, IMAGE_TAG_LOCK_PREFIX],
];

/** What a record's mark (removed, locked) holds while it is set. Anything else means it is not. */
const SET = '1';

/** Whether the kind is one of the records. */
export const isRecordKind = (aliasName: string): boolean => RECORD_KINDS.some(([alias]) => alias === aliasName);

/**
 * Whether something of another kind would take an identifier kept for a record, which would keep the
 * record from being written there.
 */
export const takesRecordIdentifier = (identifier: string, aliasName: string): boolean =>
  RECORD_KINDS.some(([alias, prefix]) => aliasName !== alias && identifier.startsWith(prefix));

/**
 * Whether a delete would take out a record, or an identifier kept for one before it is there (a
 * tombstone would keep the record from being written), by the kind stored, the kind sent or the
 * identifier.
 */
export const deletesRecord = (
  identifier: string,
  aliasName: string | null | undefined,
  storedAlias: string | null | undefined
): boolean =>
  RECORD_KINDS.some(([alias, prefix]) => storedAlias === alias || aliasName === alias || identifier.startsWith(prefix));

/** The user id a record names as its owner, or null when there is no record or it names nobody. */
export const ownerNamedIn = (record: ObjectContext | null): string | null => {
  const owner = record ? attributesOf(record).owner : null;
  return typeof owner === 'string' && owner !== '' ? owner : null;
};

/**
 * Whether a player may write a record. context is what they send, stored what the room has under that
 * identifier, and addedBy tells whom the room's record of who added an asset names. Every record has to
 * sit at the identifier of the asset or tag it names.
 *
 * - Who added an asset: naming themselves, in a record that names nobody else yet
 * - An asset taken out: marking removed one the room says they added (putting one back is the GM's)
 * - A tag kept to one person: one nobody holds locked, or one they hold; locking it names themselves
 */
export const playerMayWriteRecord = (
  context: ObjectContext,
  stored: ObjectContext | null,
  userId: string,
  addedBy: (assetIdentifier: string) => string | null
): boolean => {
  const data = attributesOf(context);
  if (context.aliasName === ASSET_OWNER_ALIAS) {
    const held = ownerNamedIn(stored);
    return (
      sitsAt(context, ASSET_OWNER_PREFIX, data.assetIdentifier) && data.owner === userId && (held ?? userId) === userId
    );
  }
  if (context.aliasName === ASSET_REMOVAL_ALIAS) {
    return (
      sitsAt(context, ASSET_REMOVAL_PREFIX, data.assetIdentifier) &&
      data.removed === SET &&
      addedBy(data.assetIdentifier as string) === userId
    );
  }
  const holder = stored && attributesOf(stored).locked === SET ? ownerNamedIn(stored) : null;
  return (
    sitsAt(context, IMAGE_TAG_LOCK_PREFIX, data.tag, encodeURIComponent) &&
    (holder ?? userId) === userId &&
    (data.locked !== SET || data.owner === userId)
  );
};

/** Whether the record sits at the identifier kept for what it names. */
const sitsAt = (
  context: ObjectContext,
  prefix: string,
  named: unknown,
  encode: (value: string) => string = (value) => value
): named is string => typeof named === 'string' && named !== '' && context.identifier === `${prefix}${encode(named)}`;
