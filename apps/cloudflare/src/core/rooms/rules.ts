import { createHash } from 'node:crypto';

import {
  AUTHORITY_PEER_ID,
  CHAT_TAB_ALIAS,
  DICE_BOT_SENDER,
  PEER_ID_USER_DIGEST_LENGTH,
  ROOM_PEER_ID_PATTERN,
  SERVER_ROLL_FIELD,
  toBase62,
} from '../../../contracts/protocol.js';
import type { EventContext, ObjectContext } from '../../../contracts/protocol.js';
import type { Seat } from './host.js';
import { MAX_VIEW_BYTES, ROLL_TIME_TOLERANCE_MS } from './limits.js';
import type { StoredEntry } from './object-index.js';
import { describe, seesDisclosed } from './visibility.js';
import type { View } from './visibility.js';

// The rules by which the room server checks what it receives. None of them keeps any state.

/**
 * Keeps a time from going back more than ROLL_TIME_TOLERANCE_MS before now. Now when it is not a
 * number. A time ahead is not pulled back. Axe puts the next message after the tab's last line, so
 * in a tab with a line at a later time, the result comes after that line too.
 */
export const notLongAgo = (timestamp: unknown): number => {
  const now = Date.now();
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return now;
  return Math.max(timestamp, now - ROLL_TIME_TOLERANCE_MS);
};

/**
 * The fraction of a place in the order. Axe gives one of 0 or more and under 1. Anything outside
 * that, and anything not a number, is 0.
 */
export const indexFraction = (value: unknown): number =>
  typeof value === 'number' && value >= 0 && value < 1 ? value : 0;

export const memberOf = (seat: Seat) => ({
  peerId: seat.peerId,
  userId: seat.userId,
  role: seat.role,
});

/**
 * Whether two seats are the same person's. Even with the same peer id, they count as different
 * people unless the user id and whether they are logged in match too. A logged-in person's user id
 * has been checked against the token, so nobody else can claim it.
 */
export const isSamePerson = (a: Seat, b: Seat): boolean => a.userId === b.userId && a.account === b.account;

/**
 * Whether that user id may claim that peer id. Axe's room peer id begins with a digest of the user
 * id, so one that does not match is someone else's peer id. One of another shape cannot be the same
 * as anyone's Axe peer id, so it is taken.
 */
export const mayClaimPeerId = (userId: string, peerId: string): boolean => {
  const shaped = ROOM_PEER_ID_PATTERN.exec(peerId);
  if (!shaped) return true;
  // Worked out synchronously, so that no other message cuts in during the check.
  const digest = toBase62(new Uint8Array(createHash('sha256').update(userId).digest()));
  return shaped[1] === digest.slice(0, PEER_ID_USER_DIGEST_LENGTH);
};

export const isHello = (value: unknown): value is { protocolVersion?: unknown } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hello';

export const fromAuthority = (eventName: string, data: unknown): EventContext => ({
  eventName,
  data,
  sendFrom: AUTHORITY_PEER_ID,
});

/**
 * Whether tag is the secret's tag with the word secret taken out: the form Axe's disclosure
 * (discloseMessage) rewrites it to.
 */
export const isDisclosureOf = (secretTag: unknown, tag: unknown): boolean => {
  const words = String(secretTag).trim().split(/\s+/);
  return words.includes('secret') && tag === words.filter((word) => word !== 'secret').join(' ');
};

/** Whether the view hint is small enough to fit in the index and in one SQLite row. */
export const fitsIndex = (context: ObjectContext): boolean => {
  const { parent, view } = describe(context);
  return parent.length <= 256 && JSON.stringify(view).length <= MAX_VIEW_BYTES;
};

/**
 * Whether someone who is not GM may change what decides the view in this way. Only what Axe's
 * screens allow is allowed.
 *
 * - Only the owner can change who a note is disclosed to. The owner can be changed by the owner, or
 *   by someone making an ownerless one their own. Only someone who can see an ownerless note now
 *   can make it their own (a GM-only note cannot be taken).
 * - The same goes for a die's owner.
 * - A card's owner (the one peeking) can only be set to oneself or cleared. A card in someone
 *   else's hand can have neither its facing nor its owner changed.
 * - A card in someone else's hand can only be drawn into one's own hand, still face down.
 * - Only the GM can change whether a tab is shown to players and guests.
 * - A message's addressees, and taking secret off it, are for the sender alone (for a roll result,
 *   the one who rolled). Nobody can change the sender.
 */
export const mayChangeView = (before: View | null, after: View | null, seat: Seat): boolean => {
  if (!before || !after || before.kind !== after.kind) return true;
  const ownerMove = (from: string, to: string) =>
    from === to || from === seat.userId || (from === '' && to === seat.userId);
  switch (before.kind) {
    case 'note': {
      const next = after as typeof before;
      const disclosureSame = before.mode === next.mode && JSON.stringify(before.users) === JSON.stringify(next.users);
      const claimsUnseen = before.owner === '' && next.owner === seat.userId && !seesDisclosed(before, seat);
      return (disclosureSame || before.owner === seat.userId) && ownerMove(before.owner, next.owner) && !claimsUnseen;
    }
    case 'die':
      return ownerMove(before.owner, (after as typeof before).owner);
    case 'card': {
      const next = after as typeof before;
      if (before.hand !== '' && before.hand !== seat.userId) {
        // Only a draw is let through: a move into one's own hand, face down, with nobody peeking
        // (Axe's "draw from the other's hand").
        const drawn = next.hand === seat.userId && !next.front && next.owner === '';
        return drawn || JSON.stringify(next) === JSON.stringify(before);
      }
      return next.owner === before.owner || next.owner === '' || next.owner === seat.userId;
    }
    case 'tab': {
      const next = after as typeof before;
      return next.pl === before.pl && next.guest === before.guest;
    }
    case 'chat': {
      const next = after as typeof before;
      if (next.from !== before.from || next.originFrom !== before.originFrom) return false;
      const sender = before.from === seat.userId || before.originFrom === seat.userId;
      const toSame = JSON.stringify(before.to) === JSON.stringify(next.to);
      return (toSame && (next.secret || !before.secret)) || sender;
    }
    default:
      return true;
  }
};

/**
 * Whether a write moves a tab under another parent. Axe does not move tabs, so nobody but the GM is
 * allowed to. If it were allowed, someone could roll in a tab made out of sight and bring the whole
 * tab into view only when the rolls were good.
 */
export const movesTab = (existing: StoredEntry, context: ObjectContext): boolean =>
  existing.alias === CHAT_TAB_ALIAS && describe(context).parent !== existing.parent;

/** User ids nobody may claim: the names Axe uses as the sender of messages. */
export const RESERVED_USER_IDS: ReadonlySet<string> = new Set([DICE_BOT_SENDER, 'System']);

/**
 * The attributes that may not be rewritten in a message with a result the server rolled (besides
 * these, the value in syncData, the parent tab and the place in the order, ROLLED_PLACE). The
 * addressees, the time and the place in the order are guarded too. Otherwise someone could roll
 * again and again addressed to themselves alone and readdress only the good rolls to everyone, or
 * move a line to any place they liked. The place in the order (disclosedAt and ROLLED_PLACE) may
 * change only when a secret is disclosed.
 */
export const ROLLED_ATTRIBUTES = [
  'disclosedAt',
  'dicebot',
  'tag',
  'name',
  'from',
  'originFrom',
  SERVER_ROLL_FIELD,
  'to',
  'timestamp',
  'editHistory',
  'fixd',
  'stamp',
  'attachmentImageIdentifiers',
  'replyTo',
  'quoteOf',
  'afterWhisperAt',
  'afterWhisperTo',
  'afterWhisperName',
];

/**
 * The attributes kept out of a roll result even when the one who asked sends them, and the values
 * put in their place (undefined drops the field). They are what shows besides the text (a stamp,
 * attached pictures, a reply or a quote), the marks of having been altered, the place in the order,
 * and marks that only come later. Axe gives a result only the default value of each.
 */
export const ROLL_NEUTRAL_ATTRIBUTES: Readonly<Record<string, unknown>> = {
  stamp: '',
  attachmentImageIdentifiers: '',
  replyTo: '',
  quoteOf: '',
  fixd: false,
  editHistory: undefined,
  disclosedAt: undefined,
  pseudoDeletedAt: undefined,
  afterWhisperAt: undefined,
  afterWhisperTo: undefined,
  afterWhisperName: undefined,
};

/**
 * Sets what may not be brought in to its default value in the attributes of a result asked for.
 * Adds nothing that was not there to begin with.
 */
export const neutralRollAttributes = (attributes: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attributes).flatMap(([field, value]): [string, unknown][] => {
      // An inherited name (constructor and the like) does not count as a field kept out.
      if (!Object.hasOwn(ROLL_NEUTRAL_ATTRIBUTES, field)) return [[field, value]];
      const neutral = ROLL_NEUTRAL_ATTRIBUTES[field];
      return neutral === undefined ? [] : [[field, neutral]];
    })
  );

/**
 * A message's place in the order. These are SyncVars of the ObjectNode itself, so they sit right
 * in syncData, not in attributes.
 */
export const ROLLED_PLACE = ['majorIndex', 'minorIndex'];

/**
 * The attributes nobody but the GM may rewrite in a message with a result the server rolled (the
 * mark that treats it as deleted).
 */
export const ROLLED_GM_ATTRIBUTES = ['pseudoDeletedAt'];
