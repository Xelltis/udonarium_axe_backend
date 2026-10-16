import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHORITY_PEER_ID,
  AuthorityEvent,
  MAX_VERSION_STEP,
  SyncEvent,
} from '../../contracts/protocol.js';
import { harness } from '../harness.js';
import {
  chatTabList,
  contextOf,
  createRoom,
  eventually,
  join,
  listedTabOf,
} from './room-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 頼むときの時刻。サーバーは、今より大きく前の時刻を今のそばへ寄せる */
const STAMP = Date.now();

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
      // Axe は並びの位置を、発言の attributes ではなく syncData の直下に置く。発言の majorIndex は 0
      majorIndex: 0,
      minorIndex: 0.25,
      value: '',
      attributes: { to: '', messColor: '#000000', timestamp: STAMP },
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
  listedTabOf(identifier, { plCanView: true, guestCanView: true, guestCanSpeak });

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
    { eventName: SyncEvent.UPDATE, data: chatTabList() },
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

  it('rolls nothing whose line comes with a version no line of Axe starts at', async () => {
    const { alice } = await room();
    const request = rollRequest('leapt', '1d1');

    alice.emit([
      {
        ...request,
        data: {
          ...request.data,
          message: { ...request.data.message, majorVersion: MAX_VERSION_STEP + 1 },
        },
      },
    ]);

    expect((await alice.events()).map((event) => event.data)).toEqual([
      { identifier: 'leapt', reason: 'invalid' },
    ]);
  });

  it('relays a roll request meant for another peer', async () => {
    const { alice, bob } = await room();

    alice.emit([rollRequest('for-bob', '1d1')], 'bob');

    expect((await bob.events())[0].eventName).toBe(AuthorityEvent.ROLL_REQUEST);
  });

  it('takes in a request’s own attributes named like an object’s inherited ones as plain values', async () => {
    const { alice, bob } = await room();
    const request = rollRequest('inherited', '1d1');
    const message = request.data.message;

    alice.emit([
      {
        ...request,
        data: {
          ...request.data,
          message: {
            ...message,
            syncData: {
              ...message.syncData,
              attributes: { ...attributes(message), constructor: 'c', toString: 't' },
            },
          },
        },
      },
    ]);

    const [{ data }] = await bob.events();
    expect(attributes(data)).toMatchObject({ constructor: 'c', toString: 't' });
  });

  it('places nothing, and says so, when the tab was taken away while the dice rolled', async () => {
    const { alice, bob } = await room('alice');

    alice.emit([
      rollRequest('orphaned', '1d1'),
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat-tab', identifier: 'main' } },
    ]);

    const told: unknown[] = [];
    for (;;) {
      const events = await alice.events();
      const rejected = events.find((event) => event.eventName === AuthorityEvent.ROLL_REJECTED);
      if (rejected) {
        told.push(rejected.data);
        break;
      }
    }
    expect(told).toEqual([{ identifier: 'orphaned', reason: 'invalid' }]);
    expect((await bob.events()).map((event) => (event.data as Message).identifier)).not.toContain(
      'orphaned',
    );
  });

  it('keeps going after a roll that fails', async () => {
    const { roomKey, alice, bob } = await room();
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await harness.inside(roomKey, ({ host }) => {
      vi.spyOn(host.store(), 'put').mockImplementationOnce(() => {
        throw new Error('store broke');
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
          stamp: 'img:a-picture',
          attachmentImageIdentifiers: 'a-picture',
          replyTo: 'another-line',
          quoteOf: 'another-line',
          fixd: true,
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
    expect(attributes(kept)).toMatchObject({ to: '', timestamp: STAMP });
  });

  it('rolls nothing outside a tab of the tab list, where the table could not see it', async () => {
    const clients = await room();
    const loose = rollRequest('loose', '1d1');
    const syncData = Object.fromEntries(
      Object.entries(loose.data.message.syncData).filter(([field]) => field !== 'parentIdentifier'),
    );
    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: contextOf('hideout', 1, 0.5, { attributes: {} }, 'chat-tab'),
      },
      { ...loose, data: { ...loose.data, message: { ...loose.data.message, syncData } } },
      rollRequest('tucked', '1d1', {}, 'hideout'),
    ]);

    const answers = await clients.alice.events();
    if (answers.length < 2) answers.push(...(await clients.alice.events()));
    expect(answers).toEqual([
      {
        eventName: AuthorityEvent.ROLL_REJECTED,
        data: { identifier: 'loose', reason: 'invalid' },
        sendFrom: AUTHORITY_PEER_ID,
      },
      {
        eventName: AuthorityEvent.ROLL_REJECTED,
        data: { identifier: 'tucked', reason: 'invalid' },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
  });

  it('stays in place, though the one who rolled it moves it or dates it differently', async () => {
    const clients = await room();
    const original = await rolledIn(clients);
    const moved = edited(original, original.syncData.value, { disclosedAt: STAMP + 60_000 });

    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: { ...moved, syncData: { ...moved.syncData, majorIndex: 999, minorIndex: 0.99 } },
      },
    ]);

    const [seen] = await clients.bob.events();
    const syncData = (seen.data as Message).syncData as Record<string, unknown>;
    expect([syncData.majorIndex, syncData.minorIndex]).toEqual([0, 0.25]);
    expect(attributes(seen.data)).not.toHaveProperty('disclosedAt');
  });

  it('takes no place in the tab but the fraction Axe gives a line, whatever the request asks', async () => {
    const clients = await room();
    const asked = (identifier: string, place: Record<string, unknown>) => {
      const request = rollRequest(identifier, '1d1');
      const syncData = Object.fromEntries(
        Object.entries(request.data.message.syncData).filter(
          ([field]) => field !== 'majorIndex' && field !== 'minorIndex',
        ),
      );
      return {
        ...request,
        data: {
          ...request.data,
          message: { ...request.data.message, syncData: { ...syncData, ...place } },
        },
      };
    };

    clients.alice.emit([
      asked('placeless', {}),
      asked('buried', { majorIndex: -1e12, minorIndex: -1e12 }),
      asked('raised', { majorIndex: 1e12, minorIndex: 1 }),
    ]);

    const places = [];
    for (let i = 0; i < 3; i++) {
      const [{ data }] = await clients.alice.events();
      const syncData = (data as Message).syncData as Record<string, unknown>;
      places.push([syncData.majorIndex, syncData.minorIndex]);
    }
    expect(places).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it('brings in none of the decorations or marks its request carries', async () => {
    const clients = await room();
    const request = rollRequest('decorated', '1d1');
    const message = request.data.message;

    clients.alice.emit([
      {
        ...request,
        data: {
          ...request.data,
          message: {
            ...message,
            syncData: {
              ...message.syncData,
              attributes: {
                ...attributes(message),
                stamp: 'img:a-picture',
                attachmentImageIdentifiers: 'a-picture',
                replyTo: 'another-line',
                quoteOf: 'another-line',
                fixd: true,
                editHistory: '6',
                disclosedAt: 1,
                pseudoDeletedAt: 5,
                afterWhisperAt: 3,
                afterWhisperTo: 'user-bob',
                afterWhisperName: 'Bob',
              },
            },
          },
        },
      },
    ]);

    const [{ data }] = await clients.alice.events();
    const brought = attributes(data);
    expect(brought).toMatchObject({
      stamp: '',
      attachmentImageIdentifiers: '',
      replyTo: '',
      quoteOf: '',
      fixd: false,
    });
    for (const field of [
      'editHistory',
      'disclosedAt',
      'pseudoDeletedAt',
      'afterWhisperAt',
      'afterWhisperTo',
      'afterWhisperName',
    ])
      expect(brought).not.toHaveProperty(field);
  });

  it('moves to the end only as its secret is disclosed', async () => {
    const clients = await room();
    const original = await secretIn(clients);
    const disclosed = edited(original, original.syncData.value, {
      tag: 'system',
      disclosedAt: STAMP + 5,
    });

    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: { ...disclosed, syncData: { ...disclosed.syncData, majorIndex: 9, minorIndex: 0.5 } },
      },
    ]);

    const [seen] = await clients.bob.events();
    const syncData = (seen.data as Message).syncData as Record<string, unknown>;
    expect([syncData.majorIndex, syncData.minorIndex]).toEqual([0, 0.5]);
  });

  it('is disclosed no further back than the server’s time allows, nor out of its fraction', async () => {
    const clients = await room();
    const original = await secretIn(clients);
    const disclosed = edited(original, original.syncData.value, { tag: 'system', disclosedAt: 1 });

    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: { ...disclosed, syncData: { ...disclosed.syncData, minorIndex: -1e12 } },
      },
    ]);

    const [seen] = await clients.bob.events();
    expect(attributes(seen.data).disclosedAt).toBeGreaterThan(Date.now() - 11 * 60_000);
    expect(((seen.data as Message).syncData as Record<string, unknown>).minorIndex).toBe(0);
  });

  it('is dated near the server’s time, however far the request dates it', async () => {
    const clients = await room();

    clients.alice.emit([
      {
        ...rollRequest('buried', '1d1'),
        data: {
          ...rollRequest('buried', '1d1').data,
          message: {
            ...prepared('buried'),
            syncData: { ...prepared('buried').syncData, attributes: { to: '', timestamp: 1 } },
          },
        },
      },
    ]);

    const [{ data }] = await clients.alice.events();
    expect(attributes(data).timestamp).toBeGreaterThan(Date.now() - 11 * 60_000);
  });

  it('keeps a date ahead of the server’s, where the tab’s latest line puts the line it answers', async () => {
    const clients = await room();
    const ahead = Date.now() + 60 * 60_000;
    const request = rollRequest('ahead', '1d1');
    const message = request.data.message;

    clients.alice.emit([
      {
        ...request,
        data: {
          ...request.data,
          message: {
            ...message,
            syncData: { ...message.syncData, attributes: { to: '', timestamp: ahead } },
          },
        },
      },
    ]);

    const [{ data }] = await clients.alice.events();
    expect(attributes(data).timestamp).toBe(ahead);
  });

  it('is not taken away with its tab by anyone but the GM', async () => {
    const clients = await room();
    const original = await rolledIn(clients);
    // alice に見えない秘話は、返すものに入れない
    clients.bob.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: contextOf(
          'aside',
          1,
          0.5,
          {
            parentIdentifier: 'main',
            value: 'psst',
            attributes: { from: 'user-bob', to: 'user-carol' },
          },
          'chat',
        ),
      },
    ]);
    await clients.carol.events();

    clients.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat-tab', identifier: 'main' } },
    ]);

    const back = await clients.alice.events();
    expect(back.map((event) => [event.eventName, (event.data as Message).identifier])).toEqual(
      expect.arrayContaining([
        [AuthorityEvent.AUTHORITATIVE, 'main'],
        [AuthorityEvent.AUTHORITATIVE, original.identifier],
      ]),
    );
    expect(back.map((event) => (event.data as Message).identifier)).not.toContain('aside');
    await clients.bob.expectQuiet();
  });

  it('keeps the lines of a tab it would not let go, though they are deleted one by one after it', async () => {
    const clients = await room();
    // bob が carol にだけ宛てて振った結果は、alice には見えない
    const whisper = rollRequest('whispered', '1d1');
    clients.bob.emit([
      {
        ...whisper,
        data: {
          ...whisper.data,
          message: {
            ...whisper.data.message,
            syncData: {
              ...whisper.data.message.syncData,
              attributes: { ...attributes(whisper.data.message), to: 'user-carol' },
            },
          },
        },
      },
    ]);
    await clients.bob.events();
    await clients.carol.events();
    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: contextOf(
          'plain',
          1,
          0.5,
          { parentIdentifier: 'main', value: 'hi', attributes: {} },
          'chat',
        ),
      },
    ]);
    await clients.bob.events();
    await clients.carol.events();

    // Axe はタブに続けて、中の行を1つずつ消す。行は別の束で来ることもある
    clients.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat-tab', identifier: 'main' } },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat', identifier: 'plain' } },
    ]);
    const back = await clients.alice.events();
    clients.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat', identifier: 'plain' } },
    ]);
    back.push(...(await clients.alice.events()));

    expect(back.map((event) => [event.eventName, (event.data as Message).identifier])).toEqual(
      expect.arrayContaining([
        [AuthorityEvent.AUTHORITATIVE, 'main'],
        [AuthorityEvent.AUTHORITATIVE, 'plain'],
      ]),
    );
    expect(back.map((event) => (event.data as Message).identifier)).not.toContain('whispered');
    await clients.bob.expectQuiet();
    await clients.carol.expectQuiet();
  });

  it('lets those lines go once the while it keeps them has passed, and keeps the lines of two tabs at once', async () => {
    const clients = await room();
    await rolledIn(clients);
    clients.alice.emit([rollRequest('in-players', '1d1', {}, 'players')]);
    await clients.alice.events();
    await clients.bob.events();
    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: contextOf(
          'plain',
          1,
          0.5,
          { parentIdentifier: 'main', value: 'hi', attributes: {} },
          'chat',
        ),
      },
    ]);
    await clients.bob.events();

    // 2つのタブを続けて消そうとする。どちらも中の行ごと消させない
    clients.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat-tab', identifier: 'main' } },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat-tab', identifier: 'players' } },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat', identifier: 'plain' } },
    ]);
    await clients.alice.events();
    await clients.bob.expectQuiet();

    await harness.inside(clients.roomKey, ({ engine }) => {
      const room = engine as unknown as { keptFromDeleting: Map<string, { until: number }> };
      for (const kept of room.keptFromDeleting.values()) kept.until = 0;
    });
    clients.alice.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'chat', identifier: 'plain' } },
    ]);

    expect(
      (await clients.bob.events()).map((event) => [
        event.eventName,
        (event.data as Message).identifier,
      ]),
    ).toEqual([[SyncEvent.DELETE, 'plain']]);
  });

  it('is rolled once for a request sent twice before either is rolled', async () => {
    const clients = await room();

    clients.alice.emit([rollRequest('twice', '1d1'), rollRequest('twice', '1d1')]);

    const [first] = await clients.alice.events();
    expect((first.data as Message).identifier).toBe('twice');
    await clients.alice.expectQuiet();
  });

  it('keeps its tab where the tab list holds it', async () => {
    const clients = await room();
    await rolledIn(clients);

    clients.alice.emit([
      {
        eventName: SyncEvent.UPDATE,
        data: {
          ...listedTabOf('main', { plCanView: true, guestCanView: true, guestCanSpeak: true }),
          majorVersion: 2,
          syncData: {
            ...listedTabOf('main', { plCanView: true, guestCanView: true, guestCanSpeak: true })
              .syncData,
            parentIdentifier: 'elsewhere',
          },
        },
      },
    ]);

    const [back] = await clients.alice.events();
    expect(back.eventName).toBe(AuthorityEvent.AUTHORITATIVE);
    expect((back.data as Message).syncData.parentIdentifier).toBe('ChatTabList');
    await clients.bob.expectQuiet();
  });

  it('answers nothing to a request for a roll already made, whoever asks again', async () => {
    const clients = await room();
    await rolledIn(clients);
    await clients.carol.events();

    // 見学者が、見学者の話せないタブで、同じ識別子を頼み直す
    clients.carol.emit([rollRequest('rolled', '1d1', {}, 'players')], AUTHORITY_PEER_ID);

    await clients.carol.expectQuiet();
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

    const disclosed = edited(original, original.syncData.value, {
      tag: 'system',
      disclosedAt: STAMP + 5,
    });
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
