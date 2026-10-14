import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTHORITY_PEER_ID, AuthorityEvent, SyncEvent } from '../contracts/protocol';
import type { RoomDurableObject } from '../src/rooms/room';
import { contextOf, createRoom, eventually, join, stubOf } from './room-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Axe が自分で振るときと同じ形で用意した、結果の発言 */
const prepared = (identifier: string, tab = 'main') =>
  contextOf(
    identifier,
    1,
    0.5,
    { parentIdentifier: tab, to: '', messColor: '#000000', attributes: { timestamp: 1 } },
    'chat',
  );

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
  contextOf(identifier, 1, 0.5, { name: identifier, guestCanSpeak }, 'chat-tab');

/** PL の alice と bob、見学者の carol がいる部屋。タブ main は見学者も話せる */
const room = async () => {
  const roomKey = await createRoom();
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
      sendFrom: AUTHORITY_PEER_ID,
    };
    for (const client of [alice, bob, carol]) expect(await client.events()).toEqual([expected]);
  });

  it('marks a secret roll', async () => {
    const { alice } = await room();

    alice.emit([rollRequest('secret-1', 's1d1')]);

    const [event] = await alice.events();
    expect(event.data).toMatchObject({
      syncData: { tag: 'system secret', name: '<Secret-BCDice：Alice>' },
    });
  });

  it('lets a guest roll where guests may speak, and nowhere else', async () => {
    const { alice, carol } = await room();

    carol.emit([rollRequest('in-players', '1d1', {}, 'players')]);
    carol.emit([rollRequest('in-main', '1d1')]);

    const [event] = await alice.events();
    expect((event.data as { identifier: string }).identifier).toBe('in-main');
    expect((event.data as { syncData: { originFrom: string } }).syncData.originFrom).toBe(
      'user-carol',
    );
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
  });
});

describe('a rolled result', () => {
  it('cannot be rewritten, though the rest of the message can', async () => {
    const { alice, bob } = await room();
    alice.emit([rollRequest('rolled', '1d1')]);
    const [{ data: rolled }] = await alice.events();
    await bob.events();
    const original = rolled as ReturnType<typeof prepared>;

    bob.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: {
          ...original,
          majorVersion: 2,
          syncData: { ...original.syncData, value: 'DiceBot : (1D1) → 6', bookmarkedAt: 5 },
        },
      },
    ]);

    const kept = {
      ...original,
      majorVersion: 2,
      syncData: { ...original.syncData, bookmarkedAt: 5 },
    };
    expect(await bob.events()).toEqual([
      { eventName: AuthorityEvent.AUTHORITATIVE, data: kept, sendFrom: AUTHORITY_PEER_ID },
    ]);
    expect((await alice.events())[0].data).toEqual(kept);
  });

  it('can be edited as before when the client sends it back unchanged', async () => {
    const { alice, bob } = await room();
    alice.emit([rollRequest('rolled', '1d1')]);
    const [{ data: rolled }] = await alice.events();
    await bob.events();
    const original = rolled as ReturnType<typeof prepared>;

    bob.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: { ...original, majorVersion: 2, syncData: { ...original.syncData, bookmarkedAt: 7 } },
      },
    ]);

    expect((await alice.events())[0].data).toMatchObject({ syncData: { bookmarkedAt: 7 } });
    await bob.expectQuiet();
  });

  it('is never claimed by a message the server did not roll', async () => {
    const { alice, bob } = await room();
    const forged = contextOf(
      'forged',
      1,
      0.5,
      { parentIdentifier: 'main', from: 'System-BCDice', value: 'DiceBot : 6', serverRoll: true },
      'chat',
    );

    alice.emit([{ eventName: SyncEvent.UPDATE, data: forged }]);

    const stripped = { ...forged, syncData: { ...forged.syncData } };
    delete (stripped.syncData as Record<string, unknown>).serverRoll;
    expect((await bob.events())[0].data).toEqual(stripped);
    expect(await alice.events()).toEqual([
      { eventName: AuthorityEvent.AUTHORITATIVE, data: stripped, sendFrom: AUTHORITY_PEER_ID },
    ]);
  });
});
