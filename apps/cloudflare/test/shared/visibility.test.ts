import { describe as group, expect, it } from 'vitest';

import type { ObjectContext } from '../../contracts/protocol.js';
import {
  describe,
  masked,
  maskedMinor,
  unmasked,
  viewFor,
  viewKind,
} from '../../src/core/rooms/visibility.js';
import type { Lookup, ViewEntry, Viewer } from '../../src/core/rooms/visibility.js';

const context = (
  aliasName: string,
  identifier: string,
  syncData: Record<string, unknown>,
): ObjectContext => ({ aliasName, identifier, majorVersion: 1, minorVersion: 0.5, syncData });

const gm: Viewer = { userId: 'u-gm', role: 'gm' };
const owner: Viewer = { userId: 'u-owner', role: 'pl' };
const player: Viewer = { userId: 'u-pl', role: 'pl' };
const guest: Viewer = { userId: 'u-guest', role: 'guest' };

/** 中身を並べた部屋の索引 */
const world = (...objects: ObjectContext[]): Lookup => {
  const entries = new Map<string, ViewEntry>(objects.map((o) => [o.identifier, describe(o)]));
  return (identifier) => entries.get(identifier) ?? null;
};

/** Axe の createDataElements と同じ形のデータ要素の木 */
const dataUnder = (holder: string, alias: string, paths: string[]) => {
  const made: ObjectContext[] = [
    context('data', `${alias}_${holder}`, {
      parentIdentifier: holder,
      attributes: { name: alias },
    }),
  ];
  for (const path of paths) {
    const [section, name] = path.split('/');
    if (!made.some((o) => o.identifier === `${section}_${holder}`)) {
      made.push(
        context('data', `${section}_${holder}`, {
          parentIdentifier: `${alias}_${holder}`,
          attributes: { name: section },
        }),
      );
    }
    if (name) {
      made.push(
        context('data', `${name}_${holder}`, {
          parentIdentifier: `${section}_${holder}`,
          value: `${name} of ${holder}`,
          attributes: { name },
        }),
      );
    }
  }
  return made;
};

group('describe', () => {
  it('reads what decides who sees each kind of object', () => {
    expect(
      describe(
        context('card', 'c', {
          attributes: { state: 1, owner: 'u-owner', location: { name: 'hand:u-pl' } },
        }),
      ),
    ).toEqual({ parent: '', view: { kind: 'card', front: false, owner: 'u-owner', hand: 'u-pl' } });
    expect(describe(context('card', 'c', {})).view).toEqual({
      kind: 'card',
      front: false,
      owner: '',
      hand: '',
    });
    expect(
      describe(
        context('text-note', 'n', {
          attributes: {
            disclosureMode: 'selected',
            disclosureUserIds: ['u-pl', 3],
            owner: 'u-owner',
          },
        }),
      ).view,
    ).toEqual({ kind: 'note', mode: 'selected', users: ['u-pl'], owner: 'u-owner' });
    expect(describe(context('text-note', 'n', {})).view).toEqual({
      kind: 'note',
      mode: '',
      users: [],
      owner: '',
    });
    expect(
      describe(
        context('chat', 'm', {
          parentIdentifier: 'tab',
          attributes: {
            to: ' u-pl  u-gm ',
            from: 'u-owner',
            originFrom: '',
            tag: 'DiceBot secret',
          },
        }),
      ),
    ).toEqual({
      parent: 'tab',
      view: { kind: 'chat', to: ['u-pl', 'u-gm'], from: 'u-owner', originFrom: '', secret: true },
    });
    expect(describe(context('chat-tab', 'SystemTab', {})).view).toEqual({
      kind: 'tab',
      pl: true,
      guest: true,
    });
    expect(describe(context('chat-reaction', 'r', { messageIdentifier: 'm' })).view).toEqual({
      kind: 'reaction',
      message: 'm',
    });
    expect(describe(context('character', 'x', { parentIdentifier: 7 }))).toEqual({
      parent: '',
      view: null,
    });
  });
});

group('cards', () => {
  const card = (attributes: Record<string, unknown>) => [
    context('card', 'card1', { attributes }),
    ...dataUnder('card1', 'card', [
      'image/front',
      'image/back',
      'common/name',
      'common/text',
      'common/size',
      'detail/hp',
    ]),
  ];

  it('shows a face-up card to everyone', () => {
    const lookup = world(...card({ state: 0 }));
    for (const viewer of [player, guest]) {
      expect(viewKind('front_card1', viewer, lookup)).toBe('full');
    }
  });

  it('keeps the face of a face-down card from players, but not the back or the size', () => {
    const lookup = world(...card({ state: 1 }));
    for (const id of ['front_card1', 'name_card1', 'text_card1', 'hp_card1']) {
      expect(viewKind(id, player, lookup)).toBe('hidden');
      expect(viewKind(id, gm, lookup)).toBe('full');
    }
    for (const id of [
      'back_card1',
      'size_card1',
      'image_card1',
      'common_card1',
      'detail_card1',
      'card_card1',
      'card1',
    ]) {
      expect(viewKind(id, player, lookup)).toBe('full');
    }
  });

  it('shows the face to the one peeking and to the hand holding it', () => {
    const peeked = world(...card({ state: 1, owner: 'u-owner' }));
    const held = world(...card({ state: 1, location: { name: 'hand:u-owner' } }));
    for (const lookup of [peeked, held]) {
      expect(viewKind('front_card1', owner, lookup)).toBe('full');
      expect(viewKind('front_card1', player, lookup)).toBe('hidden');
    }
  });
});

group('notes', () => {
  const note = (attributes: Record<string, unknown>) => [
    context('text-note', 'note1', { attributes }),
    ...dataUnder('note1', 'text-note', [
      'common/title',
      'common/text',
      'common/width',
      'detail/secret',
    ]),
  ];

  it.each([
    ['everyone', { disclosureMode: 'all' }, player, 'full'],
    ['an unknown mode', { disclosureMode: 'odd' }, player, 'full'],
    ['the GM only', { disclosureMode: 'gm' }, player, 'masked'],
    ['the GM only, seen by the GM', { disclosureMode: 'gm' }, gm, 'full'],
    ['the GM only, seen by its owner', { disclosureMode: 'gm', owner: 'u-owner' }, owner, 'full'],
    ['picked players', { disclosureMode: 'selected', disclosureUserIds: ['u-pl'] }, player, 'full'],
    [
      'picked players, seen by another',
      { disclosureMode: 'selected', disclosureUserIds: ['u-x'] },
      player,
      'masked',
    ],
  ] as const)('shows a note disclosed to %s as %s', (_name, attributes, viewer, kind) => {
    const lookup = world(...note(attributes));
    expect(viewKind('title_note1', viewer, lookup)).toBe(kind);
    expect(viewKind('text_note1', viewer, lookup)).toBe(kind);
    expect(viewKind('secret_note1', viewer, lookup)).toBe(kind === 'masked' ? 'hidden' : 'full');
    expect(viewKind('width_note1', viewer, lookup)).toBe('full');
  });
});

group('dice', () => {
  it('hides the face of a die from all but its owner and the GM', () => {
    const lookup = world(
      context('dice-symbol', 'd', { attributes: { owner: 'u-owner', face: '3' } }),
    );
    expect(viewKind('d', player, lookup)).toBe('masked');
    expect(viewKind('d', owner, lookup)).toBe('full');
    expect(viewKind('d', gm, lookup)).toBe('full');
    expect(
      viewKind('d', player, world(context('dice-symbol', 'd', { attributes: { face: '3' } }))),
    ).toBe('full');
  });
});

group('chat', () => {
  const tab = (attributes: Record<string, unknown>) => context('chat-tab', 'tab', { attributes });
  const line = (attributes: Record<string, unknown>) =>
    context('chat', 'line', { parentIdentifier: 'tab', value: 'hello', attributes });
  const open = tab({ plCanView: true, guestCanView: true });

  it('shows a whisper only to its sender and the ones it is sent to, not even the GM', () => {
    const lookup = world(open, line({ to: 'u-pl', from: 'u-owner' }));
    expect(viewKind('line', player, lookup)).toBe('full');
    expect(viewKind('line', owner, lookup)).toBe('full');
    expect(viewKind('line', gm, lookup)).toBe('hidden');
    expect(viewKind('line', guest, lookup)).toBe('hidden');
  });

  it('shows a secret line to its sender and the GM, and only its frame to the rest', () => {
    const lookup = world(
      open,
      line({ tag: 'system secret', from: 'System-BCDice', originFrom: 'u-owner' }),
    );
    expect(viewKind('line', owner, lookup)).toBe('full');
    expect(viewKind('line', gm, lookup)).toBe('full');
    expect(viewKind('line', player, lookup)).toBe('masked');
  });

  it('keeps the lines of a tab from the roles it is closed to', () => {
    const lookup = world(tab({ plCanView: false, guestCanView: true }), line({}));
    expect(viewKind('line', player, lookup)).toBe('hidden');
    expect(viewKind('line', guest, lookup)).toBe('full');
    expect(viewKind('line', gm, lookup)).toBe('full');
    expect(viewKind('line', guest, world(tab({ plCanView: true }), line({})))).toBe('hidden');
  });

  it('keeps a reaction from those who cannot see its line', () => {
    const lookup = world(
      open,
      line({ to: 'u-pl', from: 'u-owner' }),
      context('chat-reaction', 'react', { messageIdentifier: 'line' }),
    );
    expect(viewKind('react', player, lookup)).toBe('full');
    expect(viewKind('react', guest, lookup)).toBe('hidden');
  });
});

group('the walk up the parents', () => {
  it('holds back what waits for a parent that is not there yet, and stops at a loop', () => {
    const orphan = world(
      context('data', 'lost', { parentIdentifier: 'nowhere', attributes: { name: 'front' } }),
      context('chat-reaction', 'nod', { messageIdentifier: 'lost' }),
    );
    const loop = world(
      context('data', 'a', { parentIdentifier: 'b', attributes: { name: 'x' } }),
      context('data', 'b', { parentIdentifier: 'a', attributes: { name: 'y' } }),
    );
    expect(viewKind('lost', player, orphan)).toBe('pending');
    expect(viewKind('lost', gm, orphan)).toBe('pending');
    expect(viewKind('nod', player, orphan)).toBe('pending');
    expect(viewKind('a', player, loop)).toBe('full');
    expect(viewKind('unknown', player, orphan)).toBe('full');
  });
});

group('masking', () => {
  it('empties the text and the dice of a secret line, and writes them back from what is kept', () => {
    const line = context('chat', 'line', {
      value: 'DiceBot : (1D6) → 4',
      attributes: { dicebot: '{}', stamp: 's', tag: 'system secret', name: 'Kai' },
    });
    const hidden = masked(line);
    expect(hidden.syncData.value).toBe('');
    expect(hidden.syncData.attributes).toMatchObject({
      dicebot: '',
      stamp: '',
      tag: 'system secret',
      name: 'Kai',
    });
    // 置いてある中身に無い項目は undefined になる（toEqual は無いものと同じに見る）
    expect(unmasked({ ...hidden, majorVersion: 2 }, line)).toEqual({ ...line, majorVersion: 2 });
  });

  it('empties the face of a die', () => {
    const die = context('dice-symbol', 'd', { attributes: { face: '5', owner: 'u-owner' } });
    expect(masked(die).syncData.attributes).toEqual({ face: '', owner: 'u-owner' });
    expect(unmasked(masked(die), die).syncData.attributes).toEqual({ face: '5', owner: 'u-owner' });
  });

  it('blacks out the text of a note, keeping its spaces', () => {
    const title = context('data', 't', {
      value: 'Hidden door\nnorth',
      attributes: { name: 'title', currentValue: 'x y' },
    });
    expect(masked(title).syncData).toEqual({
      value: '██████ ████\n█████',
      attributes: { name: 'title', currentValue: '█ █' },
    });
    expect(masked(context('data', 'n', { value: 3 })).syncData.value).toBe(3);
    expect(unmasked(masked(title), title)).toEqual(title);
  });

  it('gives the form to show for each kind', () => {
    const die = context('dice-symbol', 'd', { attributes: { face: '5' } });
    expect(viewFor(die, 'full')).toBe(die);
    expect(viewFor(die, 'hidden')).toBeNull();
    expect(viewFor(die, 'masked')?.syncData.attributes).toEqual({ face: '' });
  });
});

group('the version of a masked copy', () => {
  it('is lower than the real one, so the real one replaces it once it may be seen', () => {
    const die = context('dice-symbol', 'd', { attributes: { face: '3', owner: 'u-owner' } });

    expect(viewFor(die, 'masked')?.minorVersion).toBe(0.25);
    expect(maskedMinor(0)).toBeLessThan(0);
    expect(viewFor(die, 'full')?.minorVersion).toBe(0.5);
  });
});

group('a line said by nobody', () => {
  it('is not taken as said by a viewer whose user id is empty', () => {
    const entry: ViewEntry = describe(
      context('chat', 'w', { attributes: { to: 'u-someone', from: 'u-sender' } }),
    );
    const lookup: Lookup = (id) => (id === 'w' ? entry : null);

    expect(viewKind('w', { userId: '', role: 'pl' }, lookup)).toBe('hidden');
  });
});
