import { MASKED_CHAT_ATTRIBUTES } from '../../../contracts/protocol.js';
import type { ObjectContext, PeerRole } from '../../../contracts/protocol.js';
import { attributesOf, withAttributes } from './objects.js';

// The rules that keep what someone must not see from reaching them. They copy the rules by which
// Axe decides on its own side what to show and what not to (a card's facing, whispers, secret dice,
// who may view a tab, disclosure).
//
// For each object a small hint that decides its view (View) is made beforehand, and from the viewer
// and the path up through the parents, it is decided whether to show it whole (full), show it with
// parts masked (masked) or not show it (hidden).
// What is still waiting for its parent (pending) cannot have the rules traced all the way, so it is
// shown to nobody until the parent comes.

/** Whoever is looking. */
export interface Viewer {
  userId: string;
  role: PeerRole;
}

export type ViewKind = 'full' | 'masked' | 'pending' | 'hidden';

/** Whether that view delivers the object to the viewer (whole, or in the masked form). */
export const delivered = (kind: ViewKind): boolean => kind === 'full' || kind === 'masked';

/** The hint that decides the view. It is made from the object's contents and kept in memory and in SQLite. */
export type View =
  /** A card. Its face is seen when it is face up, by the one peeking, and by the owner of the hand. */
  | { kind: 'card'; front: boolean; owner: string; hand: string }
  /** A note whose disclosure can be narrowed (disclosureMode). */
  | { kind: 'note'; mode: string; users: string[]; owner: string }
  /** A die with an owner. The owner is the one who sees its number. */
  | { kind: 'die'; owner: string }
  /** A chat message. Only the addressees and the sender can read a whisper, and only the sender a secret. */
  | { kind: 'chat'; to: string[]; from: string; originFrom: string; secret: boolean }
  /** A chat tab: whether players and guests may see it. */
  | { kind: 'tab'; pl: boolean; guest: boolean }
  /** A data element (a card's face, a note's text and so on). Its name tells where it belongs. */
  | { kind: 'data'; name: string }
  /** A reaction to a message. It is not shown to those who cannot see the message. */
  | { kind: 'reaction'; message: string };

/** The part of an index row that the view needs. */
export interface ViewEntry {
  parent: string;
  view: View | null;
}

/** Looks up an index row by identifier. */
export type Lookup = (identifier: string) => ViewEntry | null;

/** The tab every role can always see (Axe's SYSTEM_CHAT_TAB_IDENTIFIER). */
const SYSTEM_TAB = 'SystemTab';

const HAND_PREFIX = 'hand:';

/** The limit on how far up parents are followed. It stops even where the parents go round in a loop. */
const MAX_DEPTH = 64;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Makes the parent and the view hint from an object's contents. */
export const describe = (context: ObjectContext): ViewEntry => {
  const { syncData } = context;
  const attributes = attributesOf(context);
  const parent = text(syncData.parentIdentifier);
  switch (context.aliasName) {
    case 'card': {
      const location = text((attributes.location as { name?: unknown } | undefined)?.name);
      return {
        parent,
        view: {
          kind: 'card',
          front: attributes.state === 0,
          owner: text(attributes.owner),
          hand: location.startsWith(HAND_PREFIX) ? location.slice(HAND_PREFIX.length) : '',
        },
      };
    }
    case 'text-note':
      return {
        parent,
        view: {
          kind: 'note',
          mode: text(attributes.disclosureMode),
          users: Array.isArray(attributes.disclosureUserIds)
            ? attributes.disclosureUserIds.filter((id): id is string => typeof id === 'string')
            : [],
          owner: text(attributes.owner),
        },
      };
    case 'dice-symbol':
      return { parent, view: { kind: 'die', owner: text(attributes.owner) } };
    case 'chat':
      return {
        parent,
        view: {
          kind: 'chat',
          to: text(attributes.to).trim().split(/\s+/).filter(Boolean),
          from: text(attributes.from),
          originFrom: text(attributes.originFrom),
          secret: text(attributes.tag).split(/\s+/).includes('secret'),
        },
      };
    case 'chat-tab': {
      const always = context.identifier === SYSTEM_TAB;
      return {
        parent,
        view: {
          kind: 'tab',
          pl: always || Boolean(attributes.plCanView),
          guest: always || Boolean(attributes.guestCanView),
        },
      };
    }
    case 'data':
      return { parent, view: { kind: 'data', name: text(attributes.name) } };
    case 'chat-reaction':
      return { parent, view: { kind: 'reaction', message: text(syncData.messageIdentifier) } };
    default:
      return { parent, view: null };
  }
};

const isGameMaster = (viewer: Viewer) => viewer.role === 'gm';

/**
 * Whether the viewer sent the message. A roll result counts as sent by the one who rolled
 * (originFrom). A message with an empty sender is nobody's (a message without originFrom is not
 * matched with an empty user id).
 */
const sentBy = (view: { from: string; originFrom: string }, viewer: Viewer) =>
  viewer.userId !== '' && (view.from === viewer.userId || view.originFrom === viewer.userId);

/**
 * Whether the card's face can be seen. The GM always sees it (Axe's list for the GM shows the faces
 * of face-down cards too).
 */
const seesFace = (view: { front: boolean; owner: string; hand: string }, viewer: Viewer) =>
  isGameMaster(viewer) ||
  view.front ||
  (view.owner !== '' && view.owner === viewer.userId) ||
  (view.hand !== '' && view.hand === viewer.userId);

/** Disclosure (Axe's canViewDisclosable). The GM and the owner always see it. */
export const seesDisclosed = (view: { mode: string; users: string[]; owner: string }, viewer: Viewer) => {
  if (isGameMaster(viewer)) return true;
  if (view.owner !== '' && view.owner === viewer.userId) return true;
  if (view.mode === 'gm') return false;
  if (view.mode === 'selected') return view.users.includes(viewer.userId);
  return true;
};

/** The object's own view. */
const ownKind = (view: View | null, viewer: Viewer): ViewKind => {
  if (view?.kind === 'chat') {
    // A whisper is for its addressees and its sender only, and is kept from the GM too (Axe does not
    // show the GM whispers either).
    if (view.to.length > 0 && !view.to.includes(viewer.userId) && !sentBy(view, viewer)) {
      return 'hidden';
    }
    // A secret has its contents masked for all but the sender and the GM (the line itself is
    // delivered, and shows as "secret dice").
    return view.secret && !sentBy(view, viewer) && !isGameMaster(viewer) ? 'masked' : 'full';
  }
  if (view?.kind === 'die') {
    return view.owner !== '' && view.owner !== viewer.userId && !isGameMaster(viewer) ? 'masked' : 'full';
  }
  return 'full';
};

/**
 * The data elements under a card that are not shown to those who cannot see its face: the face
 * picture, the name, the face text and the details. The back picture, the size, the text size and
 * colour, and the containers are shown (so that the back can be drawn).
 */
const hiddenUnderCard = (path: string[]) =>
  (path[0] === 'image' && path[1] === 'front') ||
  (path[0] === 'common' && (path[1] === 'name' || path[1] === 'text')) ||
  (path[0] === 'detail' && path.length > 1);

/**
 * The data elements under a die with an owner that are not shown to those who cannot see its
 * number: the name (Axe does not draw the label at all).
 */
const hiddenUnderDie = (path: string[]) => path[0] === 'common' && path[1] === 'name';

/**
 * What is masked under a note for those outside its disclosure. The title and the text are shown
 * with their characters turned to █ (the same form Axe draws), and the details are not shown.
 */
const kindUnderNote = (path: string[]): ViewKind =>
  path[0] === 'common' && (path[1] === 'title' || path[1] === 'text')
    ? 'masked'
    : path[0] === 'detail' && path.length > 1
      ? 'hidden'
      : 'full';

/** The order of how strongly each one hides. The later, the stronger. */
const STRICTNESS: readonly ViewKind[] = ['full', 'masked', 'pending', 'hidden'];

/** Whether now shows more than then. */
export const looser = (now: ViewKind, then: ViewKind): boolean => STRICTNESS.indexOf(now) < STRICTNESS.indexOf(then);

/** Of two views, the one that hides more. */
const stricter = (a: ViewKind, b: ViewKind): ViewKind => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b);

/**
 * How the object is shown to the viewer. It follows the parents up and applies the rules of cards,
 * notes and tabs. What is not in the index (not stored yet) is full.
 *
 * When a parent has not come yet, it is pending. A child can come before its parent (loading a
 * room or copying something mixes up the order things are sent in), and taking it as full would
 * send out the face of a face-down card or a GM-only note before the rules were applied. Once the
 * parent comes, the views are compared again and it is handed over.
 */
export const viewKind = (identifier: string, viewer: Viewer, lookup: Lookup): ViewKind => {
  const entry = lookup(identifier);
  if (!entry) return 'full';
  let kind = ownKind(entry.view, viewer);
  if (entry.view?.kind === 'reaction') {
    // A reaction to a message not stored yet (or gone) waits until the message's view is settled.
    if (!lookup(entry.view.message)) return 'pending';
    const message = viewKind(entry.view.message, viewer, lookup);
    if (!delivered(message)) return message;
  }

  // Follows the parents up to those with rules, gathering the data elements' names on the way.
  const names = entry.view?.kind === 'data' ? [entry.view.name] : [];
  let current = entry;
  for (let depth = 0; depth < MAX_DEPTH && kind !== 'hidden'; depth++) {
    if (!current.parent) break;
    const parent = lookup(current.parent);
    if (!parent) return stricter(kind, 'pending');
    const view = parent.view;
    // The path from the root, leaving out the root data element (whose name is the kind of object).
    const path = names.slice(0, -1).reverse();
    if (view?.kind === 'tab' && !(isGameMaster(viewer) || (viewer.role === 'guest' ? view.guest : view.pl))) {
      return 'hidden';
    }
    if (view?.kind === 'card' && !seesFace(view, viewer) && hiddenUnderCard(path)) return 'hidden';
    if (view?.kind === 'die' && ownKind(view, viewer) === 'masked' && hiddenUnderDie(path)) return 'hidden';
    if (view?.kind === 'note' && !seesDisclosed(view, viewer)) kind = stricter(kind, kindUnderNote(path));
    if (view?.kind === 'data') names.push(view.name);
    current = parent;
  }
  return kind;
};

/** Blacks out the characters, leaving spaces as they are (the same form Axe draws a masked note in). */
const blackOut = (value: unknown) => (typeof value === 'string' ? value.replace(/\S/g, '█') : value);

/** What is masked in a secret message. */
const SECRET_ATTRIBUTES = MASKED_CHAT_ATTRIBUTES;

/** Makes the masked form. What is masked differs with the kind. */
export const masked = (context: ObjectContext): ObjectContext => {
  switch (context.aliasName) {
    case 'chat':
      return withAttributes(
        { ...context, syncData: { ...context.syncData, value: '' } },
        Object.fromEntries(SECRET_ATTRIBUTES.map((field) => [field, '']))
      );
    case 'dice-symbol':
      return withAttributes(context, { face: '' });
    default:
      return withAttributes(
        { ...context, syncData: { ...context.syncData, value: blackOut(context.syncData.value) } },
        { currentValue: blackOut(attributesOf(context).currentValue) }
      );
  }
};

/**
 * When someone who received the masked form writes it back, puts just the masked parts back to the
 * stored contents. Otherwise the real contents would be overwritten with the masked ones.
 */
export const unmasked = (incoming: ObjectContext, stored: ObjectContext): ObjectContext => {
  const kept = attributesOf(stored);
  switch (incoming.aliasName) {
    case 'chat':
      return withAttributes(
        { ...incoming, syncData: { ...incoming.syncData, value: stored.syncData.value } },
        Object.fromEntries(SECRET_ATTRIBUTES.map((field) => [field, kept[field]]))
      );
    case 'dice-symbol':
      return withAttributes(incoming, { face: kept.face });
    default:
      return withAttributes(
        { ...incoming, syncData: { ...incoming.syncData, value: stored.syncData.value } },
        { currentValue: kept.currentValue }
      );
  }
};

/**
 * The fractional part of the masked form's version. Kept lower than the real one, so that once it
 * comes into view the real version shows as newer and a catalog trade fetches it again (at the same
 * version, it would stay masked even after reconnecting).
 */
export const maskedMinor = (minorVersion: number): number => (minorVersion > 0 ? minorVersion / 2 : -0.5);

/**
 * The form shown to the viewer, or null when it is not shown. The masked form gets a version lower
 * than the real one.
 */
export const viewFor = (context: ObjectContext, kind: ViewKind): ObjectContext | null =>
  !delivered(kind)
    ? null
    : kind === 'masked'
      ? { ...masked(context), minorVersion: maskedMinor(context.minorVersion) }
      : context;
