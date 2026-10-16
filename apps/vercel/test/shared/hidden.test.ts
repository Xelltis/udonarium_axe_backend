import { describe, expect, it } from 'vitest';

import { AUTHORITY_PEER_ID, AuthorityEvent, SyncEvent } from '../../contracts/protocol.js';
import type { ObjectContext } from '../../contracts/protocol.js';
import { chatTabList, contextOf, createRoom, join, listedTabOf } from './room-helpers.js';

type Client = Awaited<ReturnType<typeof join>>['client'];
interface Event {
  eventName: string;
  data: unknown;
  sendFrom: string;
}

const update = (data: unknown) => ({ eventName: SyncEvent.UPDATE, data });

/** A card, and data elements in the same shape as the ones Axe's Card.create makes. */
const cardTree = (id: string, attributes: Record<string, unknown>, version = 1) => {
  const data = (name: string, parent: string, value: unknown = '') =>
    contextOf(`${name}_${id}`, 1, 0.5, { parentIdentifier: parent, value, attributes: { name } }, 'data');
  return {
    card: contextOf(id, version, 0.5, { attributes }, 'card'),
    elements: [
      data('card', id),
      data('image', `card_${id}`),
      data('front', `image_${id}`, `front-image-of-${id}`),
      data('back', `image_${id}`, 'back-image'),
      data('common', `card_${id}`),
      data('name', `common_${id}`, `Ace of ${id}`),
      data('detail', `card_${id}`),
    ],
  };
};

const ids = (events: Event[]) =>
  events.map((event) => [event.eventName, (event.data as { identifier: string }).identifier]);

/** A room with a GM (gm), the players alice and bob, and the guest carol. */
const table = async () => {
  const roomKey = await createRoom({}, 'gm');
  const gm = (await join(roomKey, 'gm')).client;
  const alice = (await join(roomKey, 'alice')).client;
  const bob = (await join(roomKey, 'bob')).client;
  const carol = (await join(roomKey, 'carol', { accessToken: null })).client;
  for (let i = 0; i < 3; i++) await gm.next('join');
  for (let i = 0; i < 2; i++) await alice.next('join');
  await bob.next('join');
  return { roomKey, gm, alice, bob, carol, players: [alice, bob, carol] as Client[] };
};

/** Has the GM place the objects, and waits until everyone has received them. */
const place = async (t: Awaited<ReturnType<typeof table>>, objects: ObjectContext[]) => {
  t.gm.emit(objects.map(update));
  return Promise.all(t.players.map((client) => client.events()));
};

describe('cards', () => {
  it('takes the face of a card away from players when it is turned down, and keeps it for the GM', async () => {
    const t = await table();
    const { card, elements } = cardTree('c1', { state: 0, location: { name: 'table' } });
    const [seen] = await place(t, [card, ...elements]);
    expect(seen).toHaveLength(8);

    t.gm.emit([
      update({
        ...card,
        majorVersion: 2,
        syncData: { attributes: { state: 1, location: { name: 'table' } } },
      }),
    ]);

    const withdrawn = [
      ['WITHDRAW_GAME_OBJECT', 'front_c1'],
      ['WITHDRAW_GAME_OBJECT', 'name_c1'],
    ];
    for (const player of t.players) {
      const events = await player.events();
      expect(ids(events)).toEqual([['UPDATE_GAME_OBJECT', 'c1'], ...withdrawn]);
      expect(events[1].sendFrom).toBe(AUTHORITY_PEER_ID);
    }
    await t.gm.expectQuiet();
  });

  it('gives the face to the hand that takes the card, and only to it', async () => {
    const t = await table();
    const { card, elements } = cardTree('c2', { state: 1, location: { name: 'table' } });
    t.gm.emit([card, ...elements].map(update));
    const [aliceSaw] = await Promise.all(t.players.map((client) => client.events()));
    expect(ids(aliceSaw).map(([, id]) => id)).not.toContain('front_c2');

    t.gm.emit([
      update({
        ...card,
        majorVersion: 2,
        syncData: { attributes: { state: 1, location: { name: 'hand:user-alice' } } },
      }),
    ]);

    const [toAlice, toBob] = await Promise.all([t.alice.events(), t.bob.events()]);
    expect(ids(toAlice)).toEqual([
      ['UPDATE_GAME_OBJECT', 'c2'],
      ['AUTHORITATIVE_OBJECT', 'front_c2'],
      ['AUTHORITATIVE_OBJECT', 'name_c2'],
    ]);
    expect((toAlice[1].data as ObjectContext).syncData.value).toBe('front-image-of-c2');
    expect(ids(toBob)).toEqual([['UPDATE_GAME_OBJECT', 'c2']]);
  });

  it('leaves out of the catalog and the answers what a player may not see', async () => {
    const t = await table();
    const { card, elements } = cardTree('c3', { state: 1 });
    await place(t, [card, ...elements]);

    const late = await join(t.roomKey, 'dave');
    late.client.emit([
      { eventName: SyncEvent.REQUEST, data: 'front_c3' },
      { eventName: SyncEvent.REQUEST, data: 'back_c3' },
    ]);

    const listed = (late.catalog[0].data as { identifier: string }[]).map((item) => item.identifier);
    expect(listed).toContain('back_c3');
    expect(listed).not.toContain('front_c3');
    expect(ids(await late.client.events())).toEqual([['UPDATE_GAME_OBJECT', 'back_c3']]);
  });

  it('has a player drop what it holds but may not see, and refuses its writes to it', async () => {
    const t = await table();
    const { card, elements } = cardTree('c4', { state: 1 });
    await place(t, [card, ...elements]);
    const front = elements.find((element) => element.identifier === 'front_c4') as ObjectContext;

    t.alice.emit([
      { eventName: SyncEvent.CATALOG, data: [{ identifier: 'front_c4', version: 1.5 }] },
      update({ ...front, majorVersion: 2, syncData: { ...front.syncData, value: 'forged' } }),
    ]);

    expect(await t.alice.events()).toEqual([
      {
        eventName: AuthorityEvent.WITHDRAW,
        data: { identifier: 'front_c4' },
        sendFrom: AUTHORITY_PEER_ID,
      },
      {
        eventName: AuthorityEvent.WITHDRAW,
        data: { identifier: 'front_c4' },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
    await t.gm.expectQuiet();
  });

  it('lets nobody delete what they may not see', async () => {
    const t = await table();
    const { card, elements } = cardTree('c7', { state: 1 });
    await place(t, [card, ...elements]);

    t.alice.emit([{ eventName: SyncEvent.DELETE, data: { aliasName: 'data', identifier: 'front_c7' } }]);

    await t.gm.expectQuiet();
    t.gm.emit([{ eventName: SyncEvent.REQUEST, data: 'front_c7' }]);
    expect(ids(await t.gm.events())).toEqual([['UPDATE_GAME_OBJECT', 'front_c7']]);
  });

  it('deletes with a card the parts a player could not see, for those who could', async () => {
    const t = await table();
    const { card, elements } = cardTree('c5', { state: 1 });
    await place(t, [card, ...elements]);

    t.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'card', identifier: 'c5' } },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'data', identifier: 'back_c5' } },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'data', identifier: 'front_c5' } },
    ]);

    const toGm = await t.gm.events();
    expect(toGm[0]).toEqual({
      eventName: SyncEvent.DELETE,
      data: { aliasName: 'card', identifier: 'c5' },
      sendFrom: 'alice',
    });
    expect(
      ids(toGm.slice(1))
        .map(([, id]) => id)
        .sort()
    ).toEqual(['back_c5', 'card_c5', 'common_c5', 'detail_c5', 'front_c5', 'image_c5', 'name_c5'].sort());
    const toBob = await t.bob.events();
    expect(ids(toBob).map(([, id]) => id)).not.toContain('front_c5');
  });
});

describe('parts that arrive before what they belong to', () => {
  it('keeps the face of a turned-down card from players when its parts come first', async () => {
    const t = await table();
    const { card, elements } = cardTree('c6', { state: 1, location: { name: 'table' } });

    t.gm.emit([...elements].reverse().concat(card).map(update));

    for (const player of t.players) {
      const events = await player.events();
      const seen = ids(events);
      expect(seen[0]).toEqual(['UPDATE_GAME_OBJECT', 'c6']);
      expect(seen.slice(1).map(([name]) => name)).toEqual(Array(5).fill('AUTHORITATIVE_OBJECT'));
      expect(seen.map(([, id]) => id).sort()).toEqual(
        ['back_c6', 'c6', 'card_c6', 'common_c6', 'detail_c6', 'image_c6'].sort()
      );
    }
    // The one who sent the children already has them.
    await t.gm.expectQuiet();
  });

  it('hands players the text of a memo kept to the GM only once the memo is there, blacked out', async () => {
    const t = await table();
    const memo = contextOf('m1', 1, 0.5, { attributes: { disclosureMode: 'gm', owner: '' } }, 'text-note');
    const part = (name: string, parent: string, value = '') =>
      contextOf(`${name}_m1`, 1, 0.5, { parentIdentifier: parent, value, attributes: { name } }, 'data');
    const parts = [part('text', 'common_m1', 'the secret'), part('common', 'text-note_m1'), part('text-note', 'm1')];

    t.gm.emit([...parts, memo].map(update));

    const events = await t.alice.events();
    const text = events.find((event) => (event.data as ObjectContext).identifier === 'text_m1');
    expect(text?.eventName).toBe(AuthorityEvent.AUTHORITATIVE);
    expect((text?.data as ObjectContext).syncData.value).toBe('███ ██████');
  });

  it('looks again at what lies under a part that is moved to another parent', async () => {
    const t = await table();
    const up = cardTree('c7', { state: 0, location: { name: 'table' } });
    const down = cardTree('c8', { state: 1, location: { name: 'table' } });
    await place(t, [up.card, ...up.elements, down.card, ...down.elements]);

    // Moves the holder of the face-down card's image under the face-up card.
    t.gm.emit([
      update(
        contextOf('image_c8', 2, 0.5, { parentIdentifier: 'card_c7', value: '', attributes: { name: 'image' } }, 'data')
      ),
    ]);

    for (const player of t.players) {
      const seen = ids(await player.events());
      expect(seen).toContainEqual(['AUTHORITATIVE_OBJECT', 'front_c8']);
    }
  });
});

describe('writes that would uncover what is kept back', () => {
  const memoOf = (id: string, disclosureMode: string, owner = '') =>
    contextOf(id, 1, 0.5, { attributes: { disclosureMode, owner } }, 'text-note');

  /** When refused, the sender gets back what is kept, and nothing reaches anyone else. */
  const expectRefused = async (t: Awaited<ReturnType<typeof table>>, identifier: string) => {
    const back = await t.alice.events();
    expect(ids(back)).toEqual([['AUTHORITATIVE_OBJECT', identifier]]);
    await t.bob.expectQuiet();
    return back[0].data as ObjectContext;
  };

  it('refuses a player renaming what holds the face of a turned-down card', async () => {
    const t = await table();
    const { card, elements } = cardTree('u1', { state: 1, location: { name: 'table' } });
    await place(t, [card, ...elements]);

    t.alice.emit([
      update(
        contextOf(
          'image_u1',
          2,
          0.5,
          { parentIdentifier: 'card_u1', value: '', attributes: { name: 'picture' } },
          'data'
        )
      ),
    ]);

    const kept = await expectRefused(t, 'image_u1');
    expect((kept.syncData.attributes as { name: string }).name).toBe('image');
  });

  it('refuses a player taking out from under a card what holds its name', async () => {
    const t = await table();
    const { card, elements } = cardTree('u2', { state: 1, location: { name: 'table' } });
    await place(t, [card, ...elements]);

    t.alice.emit([update(contextOf('common_u2', 2, 0.5, { value: '', attributes: { name: 'common' } }, 'data'))]);

    await expectRefused(t, 'common_u2');
  });

  it('refuses a player making someone else the sender of a secret line', async () => {
    const t = await table();
    const tab = contextOf(
      'tab-u3',
      1,
      0.5,
      { attributes: { name: 'main', plCanView: true, guestCanView: true } },
      'chat-tab'
    );
    const line = contextOf(
      'line-u3',
      1,
      0.5,
      {
        parentIdentifier: 'tab-u3',
        value: 'the GM rolled 6',
        attributes: { from: 'user-gm', tag: 'secret', to: '' },
      },
      'chat'
    );
    await place(t, [tab, line]);

    t.alice.emit([
      update({
        ...line,
        majorVersion: 2,
        syncData: {
          ...line.syncData,
          value: '',
          attributes: { from: 'user-alice', tag: 'secret' },
        },
      }),
    ]);

    const kept = await expectRefused(t, 'line-u3');
    expect(kept.syncData.value).toBe('');
  });

  it.each([
    ['peeks at', { owner: 'user-alice' }],
    ['takes into its own hand face up', { location: { name: 'hand:user-alice' }, state: 0 }],
    ['takes into its own hand peeking', { location: { name: 'hand:user-alice' }, owner: 'user-alice' }],
    ['turns up', { state: 0 }],
  ])('refuses a player who %s a card in the hand of another', async (_what, change) => {
    const t = await table();
    const { card, elements } = cardTree('u4', { state: 1, location: { name: 'hand:user-bob' } });
    await place(t, [card, ...elements]);

    t.alice.emit([
      update({
        ...card,
        majorVersion: 2,
        syncData: { attributes: { state: 1, location: { name: 'hand:user-bob' }, ...change } },
      }),
    ]);

    await expectRefused(t, 'u4');
  });

  it('lets a player draw from a deck into its own hand, which moves the card and shows it the face', async () => {
    const t = await table();
    const deck = contextOf('deck', 1, 0.5, { attributes: {} }, 'card-stack');
    const { card, elements } = cardTree('d1', { state: 1, location: { name: 'table' } });
    const stacked = { ...card, syncData: { ...card.syncData, parentIdentifier: 'deck' } };
    await place(t, [deck, stacked, ...elements]);

    // Axe sends taking a card off the deck and putting it in a hand as one write.
    t.alice.emit([
      update({
        ...card,
        majorVersion: 2,
        syncData: { attributes: { state: 1, location: { name: 'hand:user-alice' } } },
      }),
    ]);

    expect(ids(await t.alice.events())).not.toContainEqual(['AUTHORITATIVE_OBJECT', 'd1']);
    expect(ids(await t.bob.events())).toContainEqual(['UPDATE_GAME_OBJECT', 'd1']);
  });

  const owned = { state: 1, owner: 'user-alice', location: { name: 'table' } };

  /**
   * A deck, the node Axe keeps a deck's cards under, and a face-down card the GM places under the
   * one named by `holder`.
   */
  const deckTable = async (holder = 'deck-root', attributes: Record<string, unknown> = {}) => {
    const t = await table();
    const deck = contextOf('deck', 1, 0.5, { attributes: {} }, 'card-stack');
    const root = contextOf('deck-root', 1, 0.5, { parentIdentifier: 'deck', attributes: { name: 'cardRoot' } }, 'node');
    const { card, elements } = cardTree('d2', { state: 1, location: { name: 'table' }, ...attributes });
    const stacked = { ...card, syncData: { ...card.syncData, parentIdentifier: holder } };
    await place(t, [deck, root, stacked, ...elements]);
    return { ...t, deck, root, stacked };
  };

  it.each([
    ['right under the deck', 'deck'],
    ["under the node Axe keeps a deck's cards under", 'deck-root'],
  ])(
    'refuses a player making itself the owner of a card that stays %s, which would show it the face',
    async (_where, holder) => {
      const t = await deckTable(holder);

      t.alice.emit([update({ ...t.stacked, majorVersion: 2, syncData: { ...t.stacked.syncData, attributes: owned } })]);

      await expectRefused(t, 'd2');
    }
  );

  it('refuses a player putting a card it owns back into the deck it drew it from in the same frame', async () => {
    const t = await deckTable();
    const out = { ...t.stacked.syncData, parentIdentifier: '', attributes: owned };

    t.alice.emit([
      update({ ...t.stacked, majorVersion: 2, syncData: out }),
      update({ ...t.stacked, majorVersion: 3, syncData: { ...t.stacked.syncData, attributes: owned } }),
    ]);

    expect(ids(await t.alice.events())).toContainEqual(['AUTHORITATIVE_OBJECT', 'd2']);
    const seen = (await t.bob.events()).filter((event) => (event.data as ObjectContext).identifier === 'd2');
    expect((seen.at(-1)?.data as ObjectContext).syncData.parentIdentifier).toBe('');
  });

  it('refuses a player moving the node of a deck back into it once it owns a card under the node', async () => {
    const t = await deckTable();

    t.alice.emit([
      update({ ...t.root, majorVersion: 2, syncData: { ...t.root.syncData, parentIdentifier: '' } }),
      update({ ...t.stacked, majorVersion: 2, syncData: { ...t.stacked.syncData, attributes: owned } }),
      update({ ...t.root, majorVersion: 3, syncData: { ...t.root.syncData, parentIdentifier: 'deck' } }),
    ]);

    expect(ids(await t.alice.events())).toContainEqual(['AUTHORITATIVE_OBJECT', 'deck-root']);
  });

  it('lets a player rewrite, or move the deck of, a card the GM gave an owner in the deck', async () => {
    const t = await deckTable('deck-root', { owner: 'user-bob' });
    await place(t, [contextOf('shelf', 1, 0.5, { attributes: {} }, 'node')]);

    t.alice.emit([
      update({ ...t.stacked, majorVersion: 2 }),
      update({ ...t.deck, majorVersion: 2, syncData: { ...t.deck.syncData, parentIdentifier: 'shelf' } }),
    ]);

    expect(ids(await t.bob.events())).toEqual([
      ['UPDATE_GAME_OBJECT', 'd2'],
      ['UPDATE_GAME_OBJECT', 'deck'],
    ]);
    await t.alice.expectQuiet();
  });

  it('does not take a card under parents that go round in a loop for one in a deck', async () => {
    const t = await table();
    const a = contextOf('loop-a', 1, 0.5, { parentIdentifier: 'loop-b', attributes: {} }, 'node');
    const b = contextOf('loop-b', 1, 0.5, { parentIdentifier: 'loop-a', attributes: {} }, 'node');
    const { card, elements } = cardTree('d4', { state: 1, location: { name: 'table' } });
    const looped = { ...card, syncData: { ...card.syncData, parentIdentifier: 'loop-a' } };
    await place(t, [a, b, looped, ...elements]);

    t.alice.emit([update({ ...looped, majorVersion: 2, syncData: { ...looped.syncData, attributes: owned } })]);

    expect(ids(await t.bob.events())).toContainEqual(['UPDATE_GAME_OBJECT', 'd4']);
  });

  it('lets a player draw a card from the hand of another into its own, face down', async () => {
    const t = await table();
    const { card, elements } = cardTree('u5', { state: 1, location: { name: 'hand:user-bob' } });
    await place(t, [card, ...elements]);

    t.alice.emit([
      update({
        ...card,
        majorVersion: 2,
        syncData: { attributes: { state: 1, location: { name: 'hand:user-alice' } } },
      }),
    ]);

    expect(ids(await t.alice.events())).toContainEqual(['AUTHORITATIVE_OBJECT', 'front_u5']);
    const seenByBob = ids(await t.bob.events());
    expect(seenByBob).toContainEqual(['UPDATE_GAME_OBJECT', 'u5']);
    expect(seenByBob).toContainEqual(['WITHDRAW_GAME_OBJECT', 'front_u5']);
  });

  it('refuses a player moving the text of a memo kept from it under a parent not there yet', async () => {
    const t = await table();
    const memo = memoOf('m9', 'gm');
    const part = (name: string, parent: string, value = '') =>
      contextOf(`${name}_m9`, 1, 0.5, { parentIdentifier: parent, value, attributes: { name } }, 'data');
    await place(t, [
      memo,
      part('text-note', 'm9'),
      part('common', 'text-note_m9'),
      part('text', 'common_m9', 'the plan'),
    ]);

    // Moves it from under a note with rules to under a parent not there yet. Making that parent would
    // let it be read outside the rules.
    t.alice.emit([update({ ...part('common', 'ghost'), majorVersion: 2 })]);

    await expectRefused(t, 'common_m9');
  });

  it('refuses a player opening a tab to those the GM kept it from', async () => {
    const t = await table();
    const tab = listedTabOf('t1', { plCanView: true, guestCanView: false });
    await place(t, [chatTabList(), tab]);

    t.alice.emit([
      update({
        ...tab,
        majorVersion: 2,
        syncData: {
          ...tab.syncData,
          attributes: { name: 't1', plCanView: true, guestCanView: true },
        },
      }),
    ]);

    await expectRefused(t, 't1');
  });

  it('takes back, rather than answers emptily, a stale write to something whose parent is not there', async () => {
    const t = await table();
    await place(t, [contextOf('x1', 1, 0.5)]);
    // alice moved it under a parent not there yet. How it shows is not settled for anyone.
    t.alice.emit([update(contextOf('x1', 3, 0.5, { parentIdentifier: 'later' }))]);
    expect(ids(await t.gm.events())).toEqual([['WITHDRAW_GAME_OBJECT', 'x1']]);

    t.gm.emit([update(contextOf('x1', 2, 0.5))]);

    expect(ids(await t.gm.events())).toEqual([['WITHDRAW_GAME_OBJECT', 'x1']]);
  });

  it('keeps a reaction from everyone until the line it is on is there', async () => {
    const t = await table();
    t.bob.emit([update(contextOf('r9', 1, 0.5, { messageIdentifier: 'later-line', stamps: 'ok' }, 'chat-reaction'))]);

    await t.alice.expectQuiet();
    await t.carol.expectQuiet();
  });

  it('has a player drop what it holds whose parent is not there, as it does what it may not see', async () => {
    const t = await table();
    t.gm.emit([update(contextOf('orphan', 1, 0.5, { parentIdentifier: 'later' }))]);
    // The order of arrival across different WebSockets is not fixed. This goes on once the GM's write
    // has arrived.
    await t.gm.expectQuiet();

    t.alice.emit([{ eventName: SyncEvent.CATALOG, data: [{ identifier: 'orphan', version: 1.5 }] }]);

    expect(ids(await t.alice.events())).toEqual([['WITHDRAW_GAME_OBJECT', 'orphan']]);
  });

  it('hands back to its writer what it dropped while the parent was not there, once the parent comes', async () => {
    const t = await table();
    t.alice.emit([update(contextOf('kid', 1, 0.5, { parentIdentifier: 'later' }))]);
    t.alice.emit([{ eventName: SyncEvent.CATALOG, data: [{ identifier: 'kid', version: 1.5 }] }]);
    expect(ids(await t.alice.events())).toEqual([['WITHDRAW_GAME_OBJECT', 'kid']]);

    t.alice.emit([update(contextOf('later', 1, 0.5, {}))]);

    expect(ids(await t.alice.events())).toEqual([['AUTHORITATIVE_OBJECT', 'kid']]);
  });

  it('hands it back too when the parent is two steps away, and after the writer reconnects', async () => {
    const t = await table();
    t.alice.emit([update(contextOf('kid', 1, 0.5, { parentIdentifier: 'mid' }))]);
    t.alice.emit([{ eventName: SyncEvent.CATALOG, data: [{ identifier: 'kid', version: 1.5 }] }]);
    expect(ids(await t.alice.events())).toEqual([['WITHDRAW_GAME_OBJECT', 'kid']]);

    t.alice.emit([update(contextOf('mid', 1, 0.5, { parentIdentifier: 'top' }))]);
    await t.alice.expectQuiet();
    const again = (await join(t.roomKey, 'alice')).client;
    again.emit([update(contextOf('top', 1, 0.5, {}))]);

    expect(ids(await again.events())).toEqual([['AUTHORITATIVE_OBJECT', 'kid']]);
  });

  it('refuses a player claiming a memo kept to the GM, and lets one claim an open memo', async () => {
    const t = await table();
    await place(t, [memoOf('closed', 'gm'), memoOf('open', '')]);

    t.alice.emit([
      update({ ...memoOf('closed', 'gm', 'user-alice'), majorVersion: 2 }),
      update({ ...memoOf('open', '', 'user-alice'), majorVersion: 2 }),
    ]);

    expect(ids(await t.alice.events())).toEqual([['AUTHORITATIVE_OBJECT', 'closed']]);
    expect(ids(await t.bob.events())).toEqual([['UPDATE_GAME_OBJECT', 'open']]);
  });
});

describe('whispers and secrets', () => {
  const tab = contextOf(
    'tab',
    1,
    0.5,
    { attributes: { name: 'main', plCanView: true, guestCanView: true } },
    'chat-tab'
  );
  // Roll results can go only in a tab right under the tab list.
  const listedTab = listedTabOf('tab', { name: 'main', plCanView: true, guestCanView: true });
  const line = (id: string, attributes: Record<string, unknown>, version = 1) =>
    contextOf(id, version, 0.5, { parentIdentifier: 'tab', value: `text of ${id}`, attributes }, 'chat');

  it('hands a whisper to the ones it is sent to and nobody else, and moves it when it is resent', async () => {
    const t = await table();
    await place(t, [tab]);

    t.alice.emit([update(line('w1', { from: 'user-alice', to: 'user-bob' }))]);
    expect(ids(await t.bob.events())).toEqual([['UPDATE_GAME_OBJECT', 'w1']]);
    await t.carol.expectQuiet();
    await t.gm.expectQuiet();

    t.alice.emit([update(line('w1', { from: 'user-alice', to: 'user-carol' }, 2))]);
    expect(ids(await t.bob.events())).toEqual([['WITHDRAW_GAME_OBJECT', 'w1']]);
    expect(ids(await t.carol.events())).toEqual([['UPDATE_GAME_OBJECT', 'w1']]);
  });

  it('shows a secret line to the others with its text taken out, until it is disclosed', async () => {
    const t = await table();
    await place(t, [tab]);

    t.alice.emit([update(line('s1', { from: 'user-alice', tag: 'DiceBot secret', dicebot: '{}' }))]);
    const [masked] = await t.bob.events();
    const [full] = await t.gm.events();
    expect((masked.data as ObjectContext).syncData.value).toBe('');
    expect((full.data as ObjectContext).syncData.value).toBe('text of s1');

    // Even when bob, who holds the masked form, writes it back, the contents are not lost. bob gets the
    // masked form back.
    t.bob.emit([update({ ...(masked.data as ObjectContext), majorVersion: 2 })]);
    expect(((await t.gm.events())[0].data as ObjectContext).syncData.value).toBe('text of s1');
    const [kept] = await t.bob.events();
    expect(kept.eventName).toBe(AuthorityEvent.AUTHORITATIVE);
    expect((kept.data as ObjectContext).syncData.value).toBe('');

    t.alice.emit([update(line('s1', { from: 'user-alice', tag: 'DiceBot', dicebot: '{}' }, 3))]);
    expect(((await t.bob.events())[0].data as ObjectContext).syncData.value).toBe('text of s1');
  });

  it('keeps the lines of a closed tab from players, and hands them over when it opens', async () => {
    const t = await table();
    const closed = {
      ...tab,
      syncData: { attributes: { name: 'gm', plCanView: false, guestCanView: false } },
    };
    await place(t, [closed]);
    t.gm.emit([update(line('g1', { from: 'user-gm' }))]);
    await t.alice.expectQuiet();

    t.gm.emit([update({ ...tab, majorVersion: 2 })]);

    expect(ids(await t.alice.events())).toEqual([
      ['UPDATE_GAME_OBJECT', 'tab'],
      ['AUTHORITATIVE_OBJECT', 'g1'],
    ]);
  });

  it('takes back a line its sender may not see, posted to a tab closed to them', async () => {
    const t = await table();
    const closed = {
      ...tab,
      syncData: { attributes: { name: 'gm', plCanView: false, guestCanView: false } },
    };
    await place(t, [closed]);

    t.alice.emit([update(line('stray', { from: 'user-alice' }))]);

    expect(await t.alice.events()).toEqual([
      {
        eventName: AuthorityEvent.WITHDRAW,
        data: { identifier: 'stray' },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
    expect(ids(await t.gm.events())).toEqual([['UPDATE_GAME_OBJECT', 'stray']]);
  });

  it('hands a whispered roll only to the ones it is whispered to', async () => {
    const t = await table();
    await place(t, [chatTabList(), listedTab]);

    t.alice.emit([
      {
        eventName: AuthorityEvent.ROLL_REQUEST,
        data: {
          message: line('wroll', { to: 'user-bob user-alice' }),
          command: '1d1',
          gameSystem: 'DiceBot',
          speaker: 'Alice',
        },
      },
    ]);

    expect(ids(await t.bob.events())).toEqual([['UPDATE_GAME_OBJECT', 'wroll']]);
    await t.carol.expectQuiet();
  });

  it('keeps a reaction to a whisper from those the whisper is kept from', async () => {
    const t = await table();
    await place(t, [tab]);
    t.alice.emit([update(line('w2', { from: 'user-alice', to: 'user-bob' }))]);
    await t.bob.events();

    const reaction = contextOf('r1', 1, 0.5, { messageIdentifier: 'w2', stamps: 'ok' }, 'chat-reaction');
    t.bob.emit([update(reaction)]);
    expect(ids(await t.alice.events())).toEqual([['UPDATE_GAME_OBJECT', 'r1']]);
    await t.carol.expectQuiet();

    // When the addressee changes, the reactions come and go along with the message.
    t.alice.emit([update(line('w2', { from: 'user-alice', to: 'user-carol' }, 2))]);
    expect(ids(await t.carol.events())).toEqual([
      ['UPDATE_GAME_OBJECT', 'w2'],
      ['AUTHORITATIVE_OBJECT', 'r1'],
    ]);
    t.bob.emit([update({ ...reaction, majorVersion: 2 })]);
    t.bob.emit([{ eventName: SyncEvent.DELETE, data: { identifier: 'r1' } }]);
  });

  it('hands a secret roll to the others with its result taken out', async () => {
    const t = await table();
    await place(t, [chatTabList(), listedTab]);

    t.alice.emit([
      {
        eventName: AuthorityEvent.ROLL_REQUEST,
        data: {
          message: line('roll', {}),
          command: 's1d1',
          gameSystem: 'DiceBot',
          speaker: 'Alice',
        },
      },
    ]);

    const [mine] = await t.alice.events();
    const [theirs] = await t.bob.events();
    expect((mine.data as ObjectContext).syncData.value).toBe('DiceBot : (1D1) → 1');
    expect((theirs.data as ObjectContext).syncData.value).toBe('');
  });
});

describe('dice', () => {
  it('shows the face of a die only to its owner, and keeps the face when another moves it', async () => {
    const t = await table();
    const die = contextOf('d1', 1, 0.5, { attributes: { face: '6', owner: 'user-alice', x: 0 } }, 'dice-symbol');

    t.alice.emit([update(die)]);
    const [toBob] = await t.bob.events();
    expect((toBob.data as ObjectContext).syncData.attributes).toEqual({
      face: '',
      owner: 'user-alice',
      x: 0,
    });
    expect(((await t.gm.events())[0].data as ObjectContext).syncData.attributes).toMatchObject({
      face: '6',
    });

    t.bob.emit([
      update({
        ...(toBob.data as ObjectContext),
        majorVersion: 2,
        syncData: { attributes: { face: '', owner: 'user-alice', x: 5 } },
      }),
    ]);
    expect(((await t.alice.events())[0].data as ObjectContext).syncData.attributes).toEqual({
      face: '6',
      owner: 'user-alice',
      x: 5,
    });
  });
});

describe('roles and what they see', () => {
  it('hands a promoted player what the GM sees, and takes it back from a demoted one', async () => {
    const t = await table();
    const { card, elements } = cardTree('c6', { state: 1 });
    await place(t, [card, ...elements]);

    t.gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'alice', role: 'gm' } }]);
    expect(ids(await t.alice.events())).toEqual([
      ['AUTHORITATIVE_OBJECT', 'front_c6'],
      ['AUTHORITATIVE_OBJECT', 'name_c6'],
    ]);
    await t.alice.next('asset-token');

    t.gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'alice', role: 'pl' } }]);
    expect(ids(await t.alice.events())).toEqual([
      ['WITHDRAW_GAME_OBJECT', 'front_c6'],
      ['WITHDRAW_GAME_OBJECT', 'name_c6'],
    ]);
  });

  it('lists a masked die in the catalog under its masked version, and the real one once it may be seen', async () => {
    const roomKey = await createRoom({}, 'gm');
    const owner = await join(roomKey, 'alice');
    const die = (ownerId: string, major: number) =>
      contextOf('d3', major, 0.5, { attributes: { face: '5', owner: ownerId } }, 'dice-symbol');
    owner.client.emit([update(die('user-alice', 1))]);
    await owner.client.expectQuiet();

    const versionFor = async (peerId: string) => {
      const { client, catalog } = await join(roomKey, peerId);
      const items = catalog.flatMap((event) => event.data as { identifier: string; version: number }[]);
      client.close();
      return items.find((item) => item.identifier === 'd3')?.version;
    };
    const masked = await versionFor('bob');
    await owner.client.next('join');
    await owner.client.next('leave');
    owner.client.emit([update(die('', 2))]);
    await owner.client.expectQuiet();
    const opened = await versionFor('bob2');

    expect(masked).toBe(1.25);
    expect(opened).toBe(2.5);
  });

  it('sends a stale writer the kept version in the form it may see', async () => {
    const t = await table();
    const die = contextOf('d2', 3, 0.5, { attributes: { face: '2', owner: 'user-alice' } }, 'dice-symbol');
    t.alice.emit([update(die)]);
    await t.bob.events();

    // Writes with a version newer than the masked form (3.25) and older than the real one (3.5).
    t.bob.emit([update({ ...die, minorVersion: 0.4 })]);

    // The masked form carries a version below the real one, lower than the sender's, so the sender is
    // made to replace it whatever the version.
    expect(await t.bob.events()).toEqual([
      {
        eventName: AuthorityEvent.AUTHORITATIVE,
        data: {
          ...die,
          minorVersion: 0.25,
          syncData: { attributes: { face: '', owner: 'user-alice' } },
        },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
  });
});
