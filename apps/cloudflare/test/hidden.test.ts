import { describe, expect, it } from 'vitest';

import { AUTHORITY_PEER_ID, AuthorityEvent, SyncEvent } from '../contracts/protocol';
import type { ObjectContext } from '../contracts/protocol';
import { contextOf, createRoom, join } from './room-helpers';

type Client = Awaited<ReturnType<typeof join>>['client'];
interface Event {
  eventName: string;
  data: unknown;
  sendFrom: string;
}

const update = (data: unknown) => ({ eventName: SyncEvent.UPDATE, data });

/** カードと、Axe の Card.create と同じ形のデータ要素 */
const cardTree = (id: string, attributes: Record<string, unknown>, version = 1) => {
  const data = (name: string, parent: string, value: unknown = '') =>
    contextOf(
      `${name}_${id}`,
      1,
      0.5,
      { parentIdentifier: parent, value, attributes: { name } },
      'data',
    );
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

/** GM（gm）と PL の alice・bob と見学者の carol がいる部屋 */
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

/** GM が置いて、みんなが受け取るまで待つ */
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

    const listed = (late.catalog[0].data as { identifier: string }[]).map(
      (item) => item.identifier,
    );
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

    t.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'data', identifier: 'front_c7' } },
    ]);

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
        .sort(),
    ).toEqual(
      ['back_c5', 'card_c5', 'common_c5', 'detail_c5', 'front_c5', 'image_c5', 'name_c5'].sort(),
    );
    const toBob = await t.bob.events();
    expect(ids(toBob).map(([, id]) => id)).not.toContain('front_c5');
  });
});

describe('whispers and secrets', () => {
  const tab = contextOf(
    'tab',
    1,
    0.5,
    { attributes: { name: 'main', plCanView: true, guestCanView: true } },
    'chat-tab',
  );
  const line = (id: string, attributes: Record<string, unknown>, version = 1) =>
    contextOf(
      id,
      version,
      0.5,
      { parentIdentifier: 'tab', value: `text of ${id}`, attributes },
      'chat',
    );

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

    t.alice.emit([
      update(line('s1', { from: 'user-alice', tag: 'DiceBot secret', dicebot: '{}' })),
    ]);
    const [masked] = await t.bob.events();
    const [full] = await t.gm.events();
    expect((masked.data as ObjectContext).syncData.value).toBe('');
    expect((full.data as ObjectContext).syncData.value).toBe('text of s1');

    // 伏せた形を持っている bob が書き戻しても、中身は消えない。bob には伏せた形が返る
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
    await place(t, [tab]);

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

    const reaction = contextOf(
      'r1',
      1,
      0.5,
      { messageIdentifier: 'w2', stamps: 'ok' },
      'chat-reaction',
    );
    t.bob.emit([update(reaction)]);
    expect(ids(await t.alice.events())).toEqual([['UPDATE_GAME_OBJECT', 'r1']]);
    await t.carol.expectQuiet();

    // 宛先を替えると、リアクションも一緒に出入りする
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
    await place(t, [tab]);

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
    const die = contextOf(
      'd1',
      1,
      0.5,
      { attributes: { face: '6', owner: 'user-alice', x: 0 } },
      'dice-symbol',
    );

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
      const items = catalog.flatMap(
        (event) => event.data as { identifier: string; version: number }[],
      );
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
    const die = contextOf(
      'd2',
      3,
      0.5,
      { attributes: { face: '2', owner: 'user-alice' } },
      'dice-symbol',
    );
    t.alice.emit([update(die)]);
    await t.bob.events();

    t.bob.emit([update({ ...die, majorVersion: 1 })]);

    // 伏せた形には、本物より小さい版が付く
    expect(await t.bob.events()).toEqual([
      {
        eventName: SyncEvent.UPDATE,
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
