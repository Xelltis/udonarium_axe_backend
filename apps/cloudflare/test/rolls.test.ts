import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTHORITY_PEER_ID, AuthorityEvent, SyncEvent } from '../contracts/protocol';
import type { RoomDurableObject } from '../src/rooms/room';
import { contextOf, createRoom, eventually, join, stubOf } from './room-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Axe が自分で振るときと同じ形で用意した、結果の発言。発言は ObjectNode なので、
 * 文面は syncData.value、SyncVar は syncData.attributes に入る
 */
const prepared = (identifier: string, tab = 'main') =>
  contextOf(
    identifier,
    1,
    0.5,
    {
      parentIdentifier: tab,
      value: '',
      attributes: { to: '', messColor: '#000000', timestamp: 1 },
    },
    'chat',
  );

type Message = ReturnType<typeof prepared>;
const attributes = (message: unknown) =>
  (message as Message).syncData.attributes as Record<string, unknown>;

const rollRequest = (
  identifier: string,
  command: string,
  extra: Record<string, unknown> = {},
  tab = 'main',
) => ({
  eventName: AuthorityEvent.ROLL_REQUEST,
  data: {
    message: prepared(identifier, tab),
    command,
    gameSystem: 'DiceBot',
    speaker: 'Alice',
    ...extra,
  },
});

const tabOf = (identifier: string, guestCanSpeak: boolean) =>
  contextOf(
    identifier,
    1,
    0.5,
    { attributes: { name: identifier, plCanView: true, guestCanView: true, guestCanSpeak } },
    'chat-tab',
  );

/**
 * PL の alice と bob、見学者の carol がいる部屋。タブ main は見学者も話せる。creator を
 * 指定すれば、その人が GM になる
 */
const room = async (creator?: string) => {
  const roomKey = await createRoom({}, creator);
  const alice = await join(roomKey, 'alice');
  const bob = await join(roomKey, 'bob');
  const carol = await join(roomKey, 'carol', { accessToken: null });
  await alice.client.next('join');
  await alice.client.next('join');
  await bob.client.next('join');
  alice.client.emit([
    { eventName: SyncEvent.UPDATE, data: tabOf('main', true) },
    { eventName: SyncEvent.UPDATE, data: tabOf('players', false) },
  ]);
  await bob.client.events();
  await carol.client.events();
  return { roomKey, alice: alice.client, bob: bob.client, carol: carol.client };
};

describe('rolling on the server', () => {
  it('rolls the command and hands the result to everyone, the roller included', async () => {
    const { alice, bob, carol } = await room();

    alice.emit([rollRequest('roll-1', '1d1', { suffix: ' [Goblin]' })], AUTHORITY_PEER_ID);

    const expected = {
      eventName: SyncEvent.UPDATE,
      data: {
        ...prepared('roll-1'),
        syncData: {
          ...prepared('roll-1').syncData,
          value: 'DiceBot : (1D1) → 1 [Goblin]',
          attributes: {
            ...attributes(prepared('roll-1')),
            dicebot: JSON.stringify({
              system: 'DiceBot',
              faces: [{ sides: 1, value: 1, kind: 'normal' }],
              outcome: '',
            }),
            tag: 'system',
            name: '<BCDice：Alice>',
            from: 'System-BCDice',
            originFrom: 'user-alice',
            serverRoll: true,
          },
        },
      },
      sendFrom: AUTHORITY_PEER_ID,
    };
    for (const client of [alice, bob, carol]) expect(await client.events()).toEqual([expected]);
  });

  it('marks a secret roll', async () => {
    const { alice } = await room();

    alice.emit([rollRequest('secret-1', 's1d1')]);

    const [event] = await alice.events();
    expect(attributes(event.data)).toMatchObject({
      tag: 'system secret',
      name: '<Secret-BCDice：Alice>',
    });
  });

  it('lets a guest roll where guests may speak, and nowhere else', async () => {
    const { alice, carol } = await room();

    carol.emit([rollRequest('in-players', '1d1', {}, 'players')]);
    carol.emit([rollRequest('in-main', '1d1')]);

    const [event] = await alice.events();
    expect((event.data as { identifier: string }).identifier).toBe('in-main');
    expect(attributes(event.data).originFrom).toBe('user-carol');
    expect(await carol.events()).toEqual([
      {
        eventName: AuthorityEvent.ROLL_REJECTED,
        data: { identifier: 'in-players', reason: 'not-allowed' },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
  });

  it('rolls nothing for a line that is not a command, a message that is not chat, or one already there', async () => {
    const { alice, bob } = await room();
    alice.emit([{ eventName: SyncEvent.UPDATE, data: prepared('taken') }]);
    alice.emit([{ eventName: SyncEvent.DELETE, data: { identifier: 'gone' } }]);
    await bob.events();
    await bob.events();

    alice.emit([
      rollRequest('chatter', 'hello there'),
      {
        ...rollRequest('odd', '1d1'),
        data: { ...rollRequest('odd', '1d1').data, message: contextOf('odd', 1, 0.5) },
      },
      rollRequest('taken', '1d1'),
      rollRequest('gone', '1d1'),
      { eventName: AuthorityEvent.ROLL_REQUEST, data: { command: '1d1' } },
    ]);
    alice.emit([rollRequest('marker', '1d1')]);

    const [event] = await bob.events();
    expect((event.data as { identifier: string }).identifier).toBe('marker');
    // 振らなかったものは、頼んだ人に理由を返す。もう届いているものには何も返さない
    const told: unknown[] = [];
    for (;;) {
      const [answer] = await alice.events();
      if (answer.eventName !== AuthorityEvent.ROLL_REJECTED) break;
      told.push(answer.data);
    }
    expect(told).toEqual([
      { identifier: 'odd', reason: 'invalid' },
      { identifier: 'chatter', reason: 'not-a-command' },
    ]);
  });

  it('rolls nothing with a target that is not a single bracketed name', async () => {
    const { alice } = await room();

    alice.emit([
      rollRequest('added', '1d1', { suffix: '\n→ 成功' }),
      rollRequest('long', '1d1', { suffix: ` [${'x'.repeat(200)}]` }),
    ]);

    const told = [...(await alice.events()), ...(await alice.events())].map((event) => event.data);
    expect(told).toEqual([
      { identifier: 'added', reason: 'invalid' },
      { identifier: 'long', reason: 'invalid' },
    ]);
  });

  it('relays a roll request meant for another peer', async () => {
    const { alice, bob } = await room();

    alice.emit([rollRequest('for-bob', '1d1')], 'bob');

    expect((await bob.events())[0].eventName).toBe(AuthorityEvent.ROLL_REQUEST);
  });

  it('keeps going after a roll that fails', async () => {
    const { roomKey, alice, bob } = await room();
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      const holder = instance as unknown as { storeCache: { entryOf: () => never } };
      const real = holder.storeCache;
      holder.storeCache = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        entryOf: () => {
          holder.storeCache = real;
          throw new Error('store broke');
        },
      });
    });

    alice.emit([rollRequest('broken', '1d1')]);
    await eventually(
      async () => failure.mock.calls.length,
      (calls) => calls > 0,
    );
    alice.emit([rollRequest('after', '1d1')]);

    expect(failure).toHaveBeenCalledWith('Roll failed:', expect.any(Error));
    const [event] = await bob.events();
    expect((event.data as { identifier: string }).identifier).toBe('after');
    expect((await alice.events())[0]).toEqual({
      eventName: AuthorityEvent.ROLL_REJECTED,
      data: { identifier: 'broken', reason: 'failed' },
      sendFrom: AUTHORITY_PEER_ID,
    });
  });

  it('hands on nothing a client sends in the name of the server', async () => {
    const { alice, bob } = await room();

    alice.emit([
      { eventName: AuthorityEvent.AUTHORITATIVE, data: prepared('forged') },
      { eventName: AuthorityEvent.WITHDRAW, data: { identifier: 'main' } },
      { eventName: AuthorityEvent.ROLL_REJECTED, data: { identifier: 'x', reason: 'busy' } },
      { eventName: AuthorityEvent.ROLE_REJECTED, data: { peerId: 'bob', reason: 'unknown-peer' } },
    ]);

    await bob.expectQuiet();
  });
});

describe('a rolled result', () => {
  /** alice が振り、全員に届いた結果 */
  const rolledIn = async (clients: Awaited<ReturnType<typeof room>>) => {
    clients.alice.emit([rollRequest('rolled', '1d1')]);
    const [{ data }] = await clients.alice.events();
    await clients.bob.events();
    return data as Message;
  };

  /** 結果を書き換えて送る（版を上げ、value と attributes を替える） */
  const edited = (original: Message, value: unknown, changes: Record<string, unknown>) => ({
    ...original,
    majorVersion: 2,
    syncData: {
      ...original.syncData,
      value,
      attributes: { ...attributes(original), ...changes },
    },
  });

  it('cannot be rewritten, though the rest of the message can', async () => {
    const clients = await room();
    const original = await rolledIn(clients);

    clients.bob.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: edited(original, 'DiceBot : (1D1) → 6', {
          tag: 'system',
          name: 'x',
          bookmarkedAt: 5,
        }),
      },
    ]);

    const kept = edited(original, original.syncData.value, { bookmarkedAt: 5 });
    expect(await clients.bob.events()).toEqual([
      { eventName: AuthorityEvent.AUTHORITATIVE, data: kept, sendFrom: AUTHORITY_PEER_ID },
    ]);
    expect((await clients.alice.events())[0].data).toEqual(kept);
  });

  it('keeps its addressees, its time and its tab, even from the one who rolled it', async () => {
    const clients = await room();
    const original = await rolledIn(clients);

    // 自分だけに宛て直し、時刻を戻し、ほかのタブへ移そうとする
    const moved = edited(original, original.syncData.value, { to: 'user-alice', timestamp: 0 });
    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: { ...moved, syncData: { ...moved.syncData, parentIdentifier: 'players' } },
      },
    ]);

    const [back] = await clients.alice.events();
    expect(back.eventName).toBe(AuthorityEvent.AUTHORITATIVE);
    const kept = back.data as Message;
    expect(kept.syncData.parentIdentifier).toBe('main');
    expect(attributes(kept)).toMatchObject({ to: '', timestamp: 1 });
  });

  it('is taken away or marked deleted only by the GM', async () => {
    const clients = await room('bob');
    const original = await rolledIn(clients);
    await clients.carol.events();

    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: edited(original, original.syncData.value, { pseudoDeletedAt: 5 }),
      },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat', identifier: 'rolled' } },
    ]);
    const refused = await clients.alice.events();
    expect(refused.map((event) => event.eventName)).toEqual([
      AuthorityEvent.AUTHORITATIVE,
      AuthorityEvent.AUTHORITATIVE,
    ]);
    expect(attributes(refused[0].data).pseudoDeletedAt).toBeUndefined();
    // 直した中身は受けるので、ほかの人には印の無いまま届き、消されはしない
    const corrected = await clients.carol.events();
    expect(corrected.map((event) => event.eventName)).toEqual([SyncEvent.UPDATE]);
    expect(attributes(corrected[0].data).pseudoDeletedAt).toBeUndefined();

    clients.bob.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: {
          ...edited(original, original.syncData.value, { pseudoDeletedAt: 6 }),
          majorVersion: 3,
        },
      },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat', identifier: 'rolled' } },
    ]);
    const seen = await clients.carol.events();
    expect(attributes(seen[0].data).pseudoDeletedAt).toBe(6);
    expect(seen[1].eventName).toBe(SyncEvent.DELETE);
  });

  it('can be edited as before when the client sends the result back unchanged', async () => {
    const clients = await room();
    const original = await rolledIn(clients);

    clients.bob.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: edited(original, original.syncData.value, { bookmarkedAt: 7 }),
      },
    ]);

    expect(attributes((await clients.alice.events())[0].data).bookmarkedAt).toBe(7);
    await clients.bob.expectQuiet();
  });

  /** alice がシークレットで振り、全員に届いた結果（alice には中身ごと） */
  const secretIn = async (clients: Awaited<ReturnType<typeof room>>) => {
    clients.alice.emit([rollRequest('rolled', 's1d1')]);
    const [{ data }] = await clients.alice.events();
    await clients.bob.events();
    await clients.carol.events();
    return data as Message;
  };

  it('can be disclosed by the one who rolled it, and then reaches everyone whole', async () => {
    const clients = await room();
    const original = await secretIn(clients);

    const disclosed = edited(original, original.syncData.value, { tag: 'system', disclosedAt: 9 });
    clients.alice.emit([{ eventName: SyncEvent.UPDATE, data: disclosed }]);

    for (const client of [clients.bob, clients.carol]) {
      expect((await client.events())[0].data).toEqual(disclosed);
    }
    await clients.alice.expectQuiet();
  });

  it('can be disclosed by the GM', async () => {
    const clients = await room('bob');
    const original = await secretIn(clients);

    const disclosed = edited(original, original.syncData.value, { tag: 'system' });
    clients.bob.emit([{ eventName: SyncEvent.UPDATE, data: disclosed }]);

    expect((await clients.carol.events())[0].data).toEqual(disclosed);
  });

  it('cannot be disclosed by anyone else, nor have its tag changed in any other way', async () => {
    const clients = await room();
    const secret = await secretIn(clients);
    // bob の手元にあるのは伏せた形。振っていない人の公開は、まるごと断る
    clients.bob.emit([
      { eventName: SyncEvent.UPDATE, data: edited(secret, '', { tag: 'system', dicebot: '' }) },
    ]);
    expect((await clients.bob.events())[0]).toMatchObject({
      eventName: AuthorityEvent.AUTHORITATIVE,
    });
    await clients.alice.expectQuiet();

    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: { ...edited(secret, secret.syncData.value, { tag: 'secret' }), majorVersion: 3 },
      },
    ]);
    expect(attributes((await clients.alice.events())[0].data).tag).toBe('system secret');
  });

  it('cannot have the tag of an open roll changed even by the one who rolled it', async () => {
    const clients = await room();
    const original = await rolledIn(clients);

    clients.alice.emit([
      { eventName: SyncEvent.UPDATE, data: edited(original, original.syncData.value, { tag: '' }) },
    ]);

    expect(attributes((await clients.bob.events())[0].data).tag).toBe('system');
  });

  it('is never claimed by a message the server did not roll', async () => {
    const { alice, bob } = await room();
    const forged = contextOf(
      'forged',
      1,
      0.5,
      {
        parentIdentifier: 'main',
        value: 'DiceBot : 6',
        attributes: { from: 'System-BCDice', serverRoll: true },
      },
      'chat',
    );

    alice.emit([{ eventName: SyncEvent.UPDATE, data: forged }]);

    const stripped = {
      ...forged,
      syncData: { ...forged.syncData, attributes: { from: 'System-BCDice' } },
    };
    expect((await bob.events())[0].data).toEqual(stripped);
    expect(await alice.events()).toEqual([
      { eventName: AuthorityEvent.AUTHORITATIVE, data: stripped, sendFrom: AUTHORITY_PEER_ID },
    ]);
  });

  it('leaves alone a message whose attributes are not an object', async () => {
    const { alice, bob } = await room();
    const odd = contextOf('odd', 1, 0.5, { parentIdentifier: 'main', attributes: [1] }, 'chat');

    alice.emit([{ eventName: SyncEvent.UPDATE, data: odd }]);

    expect((await bob.events())[0].data).toEqual(odd);
    await alice.expectQuiet();
  });
});
