import { CHAT_TAB_LIST_IDENTIFIER } from '../../contracts/protocol';
import type { ObjectContext } from '../../contracts/protocol';

// A room shaped like one Udonarium loads from a saved zip, and an hour of play in it, to count what the
// store reads and writes. The same seed always builds the same room.

/**
 * How big a room is, in units of about 2,000 objects. `session` is close to the room measured in
 * production on 2026-10-26 (about 29,000 rows written on loading, 2 rows for each object), and `max` is
 * just under the 200,000 objects one room may hold.
 */
export const SCALES = { small: 1, session: 7, max: 97 } as const;
export type Scale = keyof typeof SCALES;

const CHARACTERS_PER_UNIT = 27;
const DETAIL_SECTIONS = 3;
const DETAIL_ELEMENTS = 10;
const CARDS_PER_UNIT = 54;
const MESSAGES_PER_UNIT = 500;
const NOTES_PER_UNIT = 10;
const DICE_PER_UNIT = 5;
const ASSETS_PER_UNIT = 18;

/** mulberry32: small, fast and the same everywhere. */
export const randomOf = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const WORDS = ['探索', '判定', '成功', '失敗', 'ダメージ', '移動', '調査', '会話', '戦闘', '回復', 'シーン', '情報'];

export interface RoomModel {
  /** Everything in the room, parents before their children, in the order a loaded zip sends them. */
  objects: ObjectContext[];
  characters: string[];
  /** The HP elements, one for each character. */
  hp: string[];
  cards: string[];
  tabs: string[];
}

const contextOf = (
  aliasName: string,
  identifier: string,
  syncData: Record<string, unknown>,
  majorVersion = 1
): ObjectContext => ({ aliasName, identifier, majorVersion, minorVersion: 0.5, syncData });

const sha = (random: () => number) => Array.from({ length: 64 }, () => Math.floor(random() * 16).toString(16)).join('');

const sentence = (random: () => number, words: number) =>
  Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]).join('、');

export const buildRoom = (scale: Scale, seed = 1): RoomModel => {
  const random = randomOf(seed);
  const units = SCALES[scale];
  const objects: ObjectContext[] = [];
  const model: RoomModel = { objects, characters: [], hp: [], cards: [], tabs: [] };
  let next = 0;
  const id = (prefix: string) => `${prefix}-${(next++).toString(36)}`;
  const data = (parent: string, name: string, value: unknown, attributes: Record<string, unknown> = {}) => {
    const identifier = id('data');
    objects.push(
      contextOf('data', identifier, { parentIdentifier: parent, value, attributes: { name, ...attributes } })
    );
    return identifier;
  };

  objects.push(contextOf('chat-tab-list', CHAT_TAB_LIST_IDENTIFIER, { attributes: {} }));
  for (let unit = 0; unit < units; unit++) {
    for (let c = 0; c < CHARACTERS_PER_UNIT; c++) {
      const character = id('character');
      model.characters.push(character);
      objects.push(
        contextOf('character', character, {
          value: '',
          attributes: {
            location: { name: 'table' },
            posX: Math.floor(random() * 2000),
            posY: Math.floor(random() * 2000),
            posZ: 0,
            rotate: 0,
            roll: 0,
            isHideIn: false,
          },
        })
      );
      const root = data(character, 'character', '');
      const image = data(root, 'image', '');
      data(image, 'imageIdentifier', sha(random), { type: 'image' });
      const common = data(root, 'common', '');
      data(common, 'name', `キャラクター${unit}-${c}`);
      data(common, 'size', 1);
      const detail = data(root, 'detail', '');
      for (let s = 0; s < DETAIL_SECTIONS; s++) {
        const section = data(detail, ['リソース', '能力値', 'メモ'][s], '');
        for (let e = 0; e < DETAIL_ELEMENTS; e++) {
          if (s === 0 && e === 0) {
            model.hp.push(data(section, 'HP', 30, { type: 'numberResource', currentValue: 30 }));
          } else if (s === 2) {
            data(section, `メモ${e}`, sentence(random, 8), { type: 'note' });
          } else {
            data(section, `能力${e}`, Math.floor(random() * 18), {});
          }
        }
      }
    }

    const stack = id('card-stack');
    objects.push(
      contextOf('card-stack', stack, {
        value: '',
        attributes: { location: { name: 'table' }, posX: 100, posY: 100, owner: '', isShowTotal: true },
      })
    );
    for (let c = 0; c < CARDS_PER_UNIT; c++) {
      const card = id('card');
      model.cards.push(card);
      objects.push(
        contextOf('card', card, {
          parentIdentifier: stack,
          value: '',
          attributes: { state: 1, owner: '', location: { name: 'table' }, posX: 100, posY: 100 },
        })
      );
      const root = data(card, 'card', '');
      const image = data(root, 'image', '');
      data(image, 'front', sha(random), { type: 'image' });
      data(image, 'back', sha(random), { type: 'image' });
      const common = data(root, 'common', '');
      data(common, 'name', `カード${c}`);
    }

    const tab = id('chat-tab');
    model.tabs.push(tab);
    objects.push(
      contextOf('chat-tab', tab, {
        parentIdentifier: CHAT_TAB_LIST_IDENTIFIER,
        value: '',
        attributes: { name: `タブ${unit}`, plCanView: true, guestCanView: true },
      })
    );
    for (let m = 0; m < MESSAGES_PER_UNIT; m++) objects.push(messageOf(id('chat'), tab, random));

    for (let n = 0; n < NOTES_PER_UNIT; n++) {
      objects.push(
        contextOf('text-note', id('text-note'), {
          value: '',
          attributes: { title: `メモ${n}`, text: sentence(random, 40), disclosureMode: '', owner: '' },
        })
      );
    }
    for (let d = 0; d < DICE_PER_UNIT; d++) {
      objects.push(
        contextOf('dice-symbol', id('dice-symbol'), {
          value: '',
          attributes: { face: '1', owner: '', location: { name: 'table' }, posX: 0, posY: 0 },
        })
      );
    }
    for (let a = 0; a < ASSETS_PER_UNIT; a++) {
      const asset = sha(random);
      objects.push(contextOf('asset-owner', `asset-owner_${asset}`, { value: '', attributes: { owner: 'user-gm' } }));
    }
  }
  return model;
};

const messageOf = (identifier: string, tab: string, random: () => number): ObjectContext =>
  contextOf('chat', identifier, {
    parentIdentifier: tab,
    value: sentence(random, 4 + Math.floor(random() * 20)),
    attributes: {
      from: 'peer-gm',
      to: '',
      name: 'GM',
      imageIdentifier: '',
      timestamp: 1_790_000_000_000 + Math.floor(random() * 1e7),
      tag: '',
      color: '#444444',
    },
  });

/** One thing a person does, as the store sees it. */
export type Operation =
  | { kind: 'put'; context: ObjectContext }
  | { kind: 'delete'; identifiers: string[] }
  | { kind: 'forget'; identifiers: string[] };

/**
 * An hour of play: 600 moves, 200 chat messages, 100 HP changes, 20 card flips, two characters deleted
 * with everything under them, and five of those brought back. The versions go up as Axe raises them.
 */
export const playHour = (model: RoomModel, seed = 2): Operation[] => {
  const random = randomOf(seed);
  const byId = new Map(model.objects.map((context) => [context.identifier, context]));
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const bump = (identifier: string, change: (syncData: Record<string, unknown>) => Record<string, unknown>) => {
    const old = byId.get(identifier) as ObjectContext;
    const updated = {
      ...old,
      majorVersion: old.majorVersion + 1,
      minorVersion: random(),
      syncData: change(old.syncData),
    };
    byId.set(identifier, updated);
    return { kind: 'put' as const, context: updated };
  };
  const attributesOf = (syncData: Record<string, unknown>) => syncData.attributes as Record<string, unknown>;

  const operations: Operation[] = [];
  const kinds = [
    ...Array<string>(600).fill('move'),
    ...Array<string>(200).fill('chat'),
    ...Array<string>(100).fill('hp'),
    ...Array<string>(20).fill('card'),
  ];
  // The same mix every time, spread over the hour rather than one kind after another.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  let messages = 0;
  for (const kind of kinds) {
    if (kind === 'move') {
      operations.push(
        bump(pick(model.characters), (syncData) => ({
          ...syncData,
          attributes: {
            ...attributesOf(syncData),
            posX: Math.floor(random() * 2000),
            posY: Math.floor(random() * 2000),
          },
        }))
      );
    } else if (kind === 'chat') {
      operations.push({ kind: 'put', context: messageOf(`chat-play-${messages++}`, pick(model.tabs), random) });
    } else if (kind === 'hp') {
      operations.push(
        bump(pick(model.hp), (syncData) => ({
          ...syncData,
          attributes: { ...attributesOf(syncData), currentValue: Math.floor(random() * 30) },
        }))
      );
    } else {
      operations.push(
        bump(pick(model.cards), (syncData) => ({
          ...syncData,
          attributes: { ...attributesOf(syncData), state: attributesOf(syncData).state === 1 ? 0 : 1 },
        }))
      );
    }
  }
  const children = new Map<string, string[]>();
  for (const context of model.objects) {
    const parent = context.syncData.parentIdentifier;
    if (typeof parent === 'string') children.set(parent, [...(children.get(parent) ?? []), context.identifier]);
  }
  const subtree = (identifier: string): string[] => [
    identifier,
    ...(children.get(identifier) ?? []).flatMap((child) => subtree(child)),
  ];
  const deleted = model.characters.slice(0, 2).flatMap((character) => subtree(character));
  operations.push({ kind: 'delete', identifiers: deleted.slice(0, deleted.length / 2) });
  operations.push({ kind: 'delete', identifiers: deleted.slice(deleted.length / 2) });
  operations.push({ kind: 'forget', identifiers: deleted.slice(0, 5) });
  return operations;
};
