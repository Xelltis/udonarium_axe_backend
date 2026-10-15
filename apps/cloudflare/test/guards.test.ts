import { runInDurableObject } from 'cloudflare:test';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthorityEvent, MAX_ROLLS_PER_WINDOW, SyncEvent, toBase62 } from '../contracts/protocol';
import type { ObjectContext } from '../contracts/protocol';
import { MAX_EVENTS_PER_MESSAGE } from '../src/rooms/messages';
import {
  MAX_EVENTS_PER_WINDOW,
  MAX_OBJECTS,
  MAX_PENDING_ROLLS,
  MAX_SOCKETS,
  MAX_VIEW_BYTES,
  TOKEN_GRACE_MS,
} from '../src/rooms/room';
import type { RoomDurableObject } from '../src/rooms/room';
import type { RoomStore } from '../src/rooms/store';
import { accessTokenFor } from './helpers';
import { connect, contextOf, createRoom, join, refusalOf, stubOf } from './room-helpers';

// 部屋のサーバーを、名乗り・書き込み・送りすぎで壊させないための守り

afterEach(() => {
  vi.restoreAllMocks();
});

interface Internals {
  store: RoomStore;
  connectedAt: WeakMap<WebSocket, number>;
  pendingRolls: number;
}

const inside = <T>(roomKey: string, run: (room: Internals, state: DurableObjectState) => T) =>
  runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject, state) =>
    run(instance as unknown as Internals, state),
  );

const update = (data: unknown) => ({ eventName: SyncEvent.UPDATE, data });

/** Axe が部屋に入るときの形のピア ID。頭はユーザー ID のダイジェスト */
const roomPeerIdOf = (userId: string) =>
  `${toBase62(new Uint8Array(createHash('sha256').update(userId).digest())).slice(0, 6)}abcRoomName-`;

describe('who a seat is', () => {
  it('keeps out the Axe peer id of somebody else, made from their user id, while they are away', async () => {
    const roomKey = await createRoom();
    const thief = await connect(roomKey);
    thief.hello(roomPeerIdOf('user-gm'), {
      userId: 'user-thief',
      accessToken: accessTokenFor('user-thief'),
    });
    expect((await thief.next('error')).code).toBe('bad-message');

    const owner = await connect(roomKey);
    owner.hello(roomPeerIdOf('user-gm'), {
      userId: 'user-gm',
      accessToken: accessTokenFor('user-gm'),
    });
    expect((await owner.next('welcome')).peerId).toBe(roomPeerIdOf('user-gm'));
  });

  it('closes the seat of a guest going by the user id of an account that comes in', async () => {
    const roomKey = await createRoom();
    const guest = await join(roomKey, 'guest-tab', { userId: 'user-alice', accessToken: null });

    await join(roomKey, 'alice');

    expect((await guest.client.next('error')).code).toBe('unauthorized');
  });

  it('keeps out a hello that takes the peer id of somebody else in the room', async () => {
    const roomKey = await createRoom();
    const gm = await join(roomKey, 'gm');
    const thief = await connect(roomKey);

    thief.hello('gm', { userId: 'someone-else', accessToken: null });

    expect((await thief.next('error')).code).toBe('bad-message');
    await gm.client.expectQuiet();
  });

  it('turns away an empty user id, and the names lines are said under', async () => {
    const roomKey = await createRoom();
    for (const userId of ['', 'System', 'System-BCDice']) {
      const client = await connect(roomKey);
      client.hello(`p-${userId.length}`, { userId, accessToken: null });
      expect((await client.next('error')).code).toBe('bad-message');
    }
  });
});

describe('what a write may change', () => {
  it('never lets a write turn one kind of object into another', async () => {
    const roomKey = await createRoom();
    const gm = await join(roomKey, 'gm');
    const tab = contextOf(
      'tab',
      1,
      0.5,
      { attributes: { name: 'gm', plCanView: false } },
      'chat-tab',
    );
    gm.client.emit([update(tab)]);
    await gm.client.expectQuiet();
    const guest = await join(roomKey, 'guest', { accessToken: null, userId: 'guest-1' });
    await gm.client.next('join');

    guest.client.emit([
      update(contextOf('tab', 9, 0.5, { peerId: 'guest', name: 'guest' }, 'PeerCursor')),
    ]);

    // 書き戻させるのは、置いてあるタブのまま
    const [answer] = await guest.client.events();
    expect(answer.eventName).toBe(AuthorityEvent.AUTHORITATIVE);
    expect((answer.data as ObjectContext).aliasName).toBe('chat-tab');
    await gm.client.expectQuiet();
  });

  it('turns away a write too large to index', async () => {
    const roomKey = await createRoom();
    const gm = await join(roomKey, 'gm');
    const longParent = contextOf('a', 1, 0.5, { parentIdentifier: 'p'.repeat(300) });
    const wideWhisper = contextOf(
      'b',
      1,
      0.5,
      { attributes: { to: 'u '.repeat(MAX_VIEW_BYTES) } },
      'chat',
    );

    gm.client.emit([update(longParent), update(wideWhisper)]);

    expect((await gm.client.events()).map((event) => event.eventName)).toEqual([
      AuthorityEvent.WITHDRAW,
      AuthorityEvent.WITHDRAW,
    ]);
  });

  it('takes no new object past the most a room holds', async () => {
    const roomKey = await createRoom();
    const gm = await join(roomKey, 'gm');
    await inside(roomKey, (room) =>
      vi.spyOn(room.store, 'size', 'get').mockReturnValue(MAX_OBJECTS),
    );

    gm.client.emit([update(contextOf('one-too-many', 1, 0.5))]);

    expect((await gm.client.events())[0].eventName).toBe(AuthorityEvent.WITHDRAW);
  });

  describe('what decides who sees what', () => {
    const table = async () => {
      const roomKey = await createRoom({}, 'gm');
      const gm = await join(roomKey, 'gm');
      const alice = await join(roomKey, 'alice');
      const bob = await join(roomKey, 'bob');
      await gm.client.next('join');
      await gm.client.next('join');
      await alice.client.next('join');
      return { gm: gm.client, alice: alice.client, bob: bob.client };
    };
    const note = (owner: string, mode: string, major = 1, users: string[] = []) =>
      contextOf(
        'note',
        major,
        0.5,
        { attributes: { owner, disclosureMode: mode, disclosureUserIds: users } },
        'text-note',
      );
    const refusedTo = async (client: Awaited<ReturnType<typeof table>>['bob']) =>
      (await client.events())[0].eventName;

    it('lets only the owner of a memo widen who reads it, and the GM', async () => {
      const t = await table();
      t.alice.emit([update(note('user-alice', 'gm'))]);
      await t.gm.events();
      await t.bob.events();

      t.bob.emit([update(note('user-alice', 'all', 2))]);
      expect(await refusedTo(t.bob)).toBe(AuthorityEvent.AUTHORITATIVE);
      t.bob.emit([update(note('user-bob', 'gm', 2))]);
      expect(await refusedTo(t.bob)).toBe(AuthorityEvent.AUTHORITATIVE);

      t.alice.emit([update(note('user-alice', 'selected', 3, ['user-bob']))]);
      expect((await t.bob.events())[0].eventName).toBe(SyncEvent.UPDATE);
      t.gm.emit([update(note('', 'gm', 4))]);
      expect((await t.alice.events())[0].eventName).toBe(SyncEvent.UPDATE);
    });

    it('lets anybody claim a memo or die nobody owns, and nobody else take it', async () => {
      const t = await table();
      t.gm.emit([update(note('', 'all'))]);
      await t.alice.events();
      await t.bob.events();

      t.alice.emit([update(note('user-alice', 'all', 2))]);
      await t.bob.events();
      const die = (owner: string, major: number) =>
        contextOf('die', major, 0.5, { attributes: { owner, face: '1' } }, 'dice-symbol');
      t.alice.emit([update(die('user-alice', 1))]);
      await t.bob.events();
      t.bob.emit([update(die('user-bob', 2))]);

      expect(await refusedTo(t.bob)).toBe(AuthorityEvent.AUTHORITATIVE);
    });

    it('lets a player peek at a card for themselves only', async () => {
      const t = await table();
      const card = (owner: string, major: number) =>
        contextOf('card', major, 0.5, { attributes: { state: 1, owner } }, 'card');
      t.gm.emit([update(card('', 1))]);
      await t.alice.events();
      await t.bob.events();

      t.alice.emit([update(card('user-alice', 2))]);
      await t.bob.events();
      t.bob.emit([update(card('', 3))]);
      await t.alice.events();
      t.bob.emit([update(card('user-alice', 4))]);

      expect(await refusedTo(t.bob)).toBe(AuthorityEvent.AUTHORITATIVE);
    });

    it('lets only the one who said a line change who it is said to, or take its secret off', async () => {
      const t = await table();
      const line = (to: string, tag: string, major: number) =>
        contextOf(
          'line',
          major,
          0.5,
          { value: 'hi', attributes: { from: 'user-alice', to, tag } },
          'chat',
        );
      t.alice.emit([update(line('', 'secret', 1))]);
      await t.gm.events();
      await t.bob.events();

      t.bob.emit([update(line('user-bob', 'secret', 2))]);
      expect(await refusedTo(t.bob)).toBe(AuthorityEvent.AUTHORITATIVE);
      t.bob.emit([update(line('', '', 2))]);
      expect(await refusedTo(t.bob)).toBe(AuthorityEvent.AUTHORITATIVE);

      t.alice.emit([update(line('', '', 2))]);
      expect((await t.bob.events())[0].eventName).toBe(SyncEvent.UPDATE);
    });

    it('leaves alone what decides nothing, and objects that change no such thing', async () => {
      const t = await table();
      const piece = (major: number) => contextOf('piece', major, 0.5, { attributes: { x: major } });
      t.gm.emit([update(piece(1))]);
      await t.bob.events();
      t.bob.emit([update(piece(2))]);
      expect((await t.alice.events())[0].eventName).toBe(SyncEvent.UPDATE);

      const tab = (major: number, pl: boolean) =>
        contextOf('t', major, 0.5, { attributes: { name: 't', plCanView: pl } }, 'chat-tab');
      t.gm.emit([update(tab(1, true))]);
      await t.bob.events();
      t.bob.emit([update(tab(2, true))]);
      expect((await t.alice.events())[0].eventName).toBe(SyncEvent.UPDATE);
    });
  });
});

describe('connections that say nothing', () => {
  it('closes one that has not said hello in time when another arrives', async () => {
    const roomKey = await createRoom();
    const silent = await connect(roomKey);
    await inside(roomKey, (room, state) => {
      for (const ws of state.getWebSockets()) room.connectedAt.set(ws, 0);
    });

    const late = await connect(roomKey);
    late.hello('late');

    expect((await silent.next('error')).code).toBe('hello-required');
    expect((await late.next('welcome')).peerId).toBe('late');
  });

  it('counts only the connections still open toward the most a room takes', async () => {
    const roomKey = await createRoom();
    const sockets = [];
    for (let i = 0; i < MAX_SOCKETS; i++) sockets.push(await connect(roomKey));
    expect(await refusalOf(roomKey)).toBe('room-full');

    await inside(roomKey, (room, state) => {
      for (const ws of state.getWebSockets()) room.connectedAt.set(ws, 0);
    });
    const fresh = await connect(roomKey);
    fresh.hello('fresh');
    expect((await fresh.next('welcome')).peerId).toBe('fresh');
  }, 90_000);
});

describe('sending too much', () => {
  it('counts every event in a frame, and closes on too many', async () => {
    const roomKey = await createRoom();
    const noisy = await join(roomKey, 'noisy');
    const frame = Array.from({ length: MAX_EVENTS_PER_MESSAGE }, () => ({
      eventName: 'NOTHING',
      data: null,
    }));

    for (let i = 0; i * MAX_EVENTS_PER_MESSAGE <= MAX_EVENTS_PER_WINDOW; i++)
      noisy.client.emit(frame);

    expect((await noisy.client.next('error')).code).toBe('too-many-messages');
  }, 90_000);

  it('rolls no more than a seat may ask for, nor more than the room may wait on', async () => {
    const roomKey = await createRoom();
    const roller = await join(roomKey, 'roller');
    const ask = (identifier: string) => ({
      eventName: AuthorityEvent.ROLL_REQUEST,
      data: {
        message: contextOf(identifier, 1, 0.5, { value: '', attributes: {} }, 'chat'),
        command: '1d6',
        gameSystem: 'DiceBot',
        speaker: 'roller',
      },
    });

    roller.client.emit(
      Array.from({ length: MAX_ROLLS_PER_WINDOW + 1 }, (_, i) => ask(`r${i}`)),
      '@authority',
    );
    const rolled = new Set<string>();
    const refused: unknown[] = [];
    while (rolled.size < MAX_ROLLS_PER_WINDOW || refused.length === 0) {
      for (const event of await roller.client.events()) {
        if (event.eventName === AuthorityEvent.ROLL_REJECTED) refused.push(event.data);
        else rolled.add((event.data as ObjectContext).identifier);
      }
    }
    await roller.client.expectQuiet();
    expect(rolled.has(`r${MAX_ROLLS_PER_WINDOW}`)).toBe(false);
    expect(refused).toEqual([{ identifier: `r${MAX_ROLLS_PER_WINDOW}`, reason: 'rate-limited' }]);

    await inside(roomKey, (room) => {
      room.pendingRolls = MAX_PENDING_ROLLS;
    });
    const other = await join(roomKey, 'other');
    other.client.emit([ask('waiting')], '@authority');
    expect((await other.client.events())[0]).toEqual({
      eventName: AuthorityEvent.ROLL_REJECTED,
      data: { identifier: 'waiting', reason: 'busy' },
      sendFrom: '@authority',
    });
    await inside(roomKey, (room) => {
      room.pendingRolls = 0;
    });
  }, 90_000);
});

describe('a login that runs out while connected', () => {
  it('lets a seat stay on a fresh token, and closes one whose token ran out', async () => {
    const roomKey = await createRoom();
    const alice = await join(roomKey, 'alice');
    const bob = await join(roomKey, 'bob');
    await alice.client.next('join');

    alice.client.send({ type: 'auth', accessToken: accessTokenFor('user-alice') });
    await alice.client.expectQuiet();
    await inside(roomKey, (_room, state) => {
      for (const ws of state.getWebSockets()) {
        const seat = ws.deserializeAttachment() as { peerId: string } | null;
        if (seat?.peerId === 'bob')
          ws.serializeAttachment({ ...seat, expiresAt: Date.now() - TOKEN_GRACE_MS - 1 });
      }
    });

    alice.client.emit([]);

    expect((await bob.client.next('error')).code).toBe('unauthorized');
    expect(await alice.client.next('leave')).toEqual({ type: 'leave', peerId: 'bob' });
  });

  it('closes a seat that hands over somebody else’s token, and ignores one from a guest', async () => {
    const roomKey = await createRoom();
    const guest = await join(roomKey, 'guest', { accessToken: null, userId: 'guest-1' });
    guest.client.send({ type: 'auth', accessToken: accessTokenFor('user-somebody') });
    await guest.client.expectQuiet();

    const alice = await join(roomKey, 'alice');
    alice.client.send({ type: 'auth', accessToken: accessTokenFor('user-somebody') });

    expect((await alice.client.next('error')).code).toBe('unauthorized');
  });
});
