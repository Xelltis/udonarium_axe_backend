import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_USER_ID_PREFIX,
  AUTHORITY_PEER_ID,
  AuthorityEvent,
  SyncEvent,
} from '../contracts/protocol';
import { readToken, signToken } from '../src/auth/tokens';
import app from '../src/index';
import type { RoomDurableObject } from '../src/rooms/room';
import { ORIGIN, SESSION_SECRET, accessTokenFor } from './helpers';
import { connect, contextOf, createRoom, join, postRoom, stubOf } from './room-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const cursorOf = (peerId: string, role: string, majorVersion = 1) =>
  contextOf(
    `cursor-${peerId}`,
    majorVersion,
    0.5,
    { peerId, userId: `user-${peerId}`, name: peerId, role },
    'PeerCursor',
  );

// タブも発言も ObjectNode なので、SyncVar は attributes に入る
const tabOf = (identifier: string, guestCanSpeak: boolean) =>
  contextOf(
    identifier,
    1,
    0.5,
    { attributes: { name: identifier, plCanView: true, guestCanView: true, guestCanSpeak } },
    'chat-tab',
  );

const messageOf = (identifier: string, tab: string, from: string, majorVersion = 1) =>
  contextOf(
    identifier,
    majorVersion,
    0.5,
    { parentIdentifier: tab, value: 'hi', attributes: { from } },
    'chat',
  );

/** GM（gm）と PL（pl）と見学者（guest）のいる部屋 */
const table = async () => {
  const roomKey = await createRoom({}, 'gm');
  const gm = await join(roomKey, 'gm');
  const pl = await join(roomKey, 'pl');
  const guest = await join(roomKey, 'guest', { accessToken: null });
  await gm.client.next('join');
  await gm.client.next('join');
  await pl.client.next('join');
  return { roomKey, gm: gm.client, pl: pl.client, guest: guest.client, welcomes: [gm, pl, guest] };
};

describe('opening a room', () => {
  it('is not offered on a Worker without login', async () => {
    const res = await app.fetch(
      new Request('https://backend.example/v1/rooms', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'room' }),
      }),
      {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
      },
      createExecutionContext(),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'login-unavailable' });
  });

  it('asks for login', async () => {
    const none = await postRoom({ name: 'room' }, { Authorization: '' });
    const expired = await postRoom(
      { name: 'room' },
      { Authorization: `Bearer ${accessTokenFor('late', -1)}` },
    );

    for (const res of [none, expired]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'login-required' });
    }
  });
});

describe('roles', () => {
  it('makes the one who opened the room the GM, others who log in players, and the rest guests', async () => {
    const { welcomes } = await table();

    expect(welcomes.map(({ welcome }) => welcome.role)).toEqual(['gm', 'pl', 'guest']);
    expect(welcomes[2].welcome.members).toHaveLength(2);
    expect(welcomes[2].welcome.members).toEqual(
      expect.arrayContaining([
        { peerId: 'gm', userId: 'user-gm', role: 'gm' },
        { peerId: 'pl', userId: 'user-pl', role: 'pl' },
      ]),
    );
  });

  it('turns away a token that is not valid, or that is for someone else', async () => {
    const roomKey = await createRoom();
    const forged = await connect(roomKey);
    const borrowed = await connect(roomKey);

    forged.hello('mallory', { accessToken: 'forged' });
    borrowed.hello('mallory', { accessToken: accessTokenFor('user-alice') });

    for (const client of [forged, borrowed]) {
      expect((await client.next('error')).code).toBe('unauthorized');
    }
  });

  it('turns away a guest who claims the user id of someone logged in', async () => {
    // ログインした人のユーザー ID はカーソルに見える。名乗れば、その人の手札や秘話が見えてしまう
    const roomKey = await createRoom();
    const impostor = await connect(roomKey);

    impostor.hello('mallory', { userId: `${ACCOUNT_USER_ID_PREFIX}victim`, accessToken: null });

    expect((await impostor.next('error')).code).toBe('unauthorized');
  });

  it('keeps a role for the next time the same user comes in', async () => {
    const { roomKey, gm, pl } = await table();
    gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'pl', role: 'guest' } }]);
    await gm.expectQuiet();
    pl.close();

    const again = await join(roomKey, 'pl');

    expect(again.welcome.role).toBe('guest');
  });

  it('lets in only guests once login is taken away from the Worker', async () => {
    const roomKey = await createRoom();
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      (instance as unknown as { env: Env }).env = {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
      } as Env;
    });

    const anonymous = await join(roomKey, 'anon', { accessToken: null });
    const member = await connect(roomKey);
    member.hello('member');

    expect(anonymous.welcome.role).toBe('guest');
    expect((await member.next('error')).code).toBe('unauthorized');
  });

  it('takes no token signed with an empty secret once login is taken away', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      (instance as unknown as { env: Env }).env = {
        ...env,
        DISCORD_CLIENT_ID: undefined,
        DISCORD_CLIENT_SECRET: undefined,
        SESSION_SECRET: undefined,
      } as Env;
    });
    const forged = signToken<'access'>(
      { aud: 'access', sub: 'discord:gm', uid: 'user-gm', name: 'gm' },
      60,
      '',
    );

    const impostor = await connect(roomKey);
    impostor.hello('impostor', { userId: 'user-gm', accessToken: forged });
    const anonymous = await join(roomKey, 'anon', { accessToken: null });
    gm.client.send({ type: 'invite', role: 'gm' });
    gm.client.send({ type: 'asset-token' });

    expect((await impostor.next('error')).code).toBe('unauthorized');
    expect(anonymous.welcome.assetToken).toBe('');
    await gm.client.next('join');
    expect((await gm.client.next('invite')).invite).toBeNull();
    expect((await gm.client.next('asset-token')).assetToken).toBe('');
    gm.client.send({ type: 'auth', accessToken: forged });
    expect((await gm.client.next('error')).code).toBe('unauthorized');
  });
});

describe('invites', () => {
  it('lets the GM hand out a role to someone coming in for the first time', async () => {
    const { roomKey, gm, pl } = await table();

    gm.send({ type: 'invite', role: 'gm' });
    const invite = await gm.next('invite');
    pl.send({ type: 'invite', role: 'gm' });
    const refused = await pl.next('invite');
    const coGm = await join(roomKey, 'co-gm', { invite: invite.invite });
    // pl は入ったことがあるので、招待があっても役割は変わらない
    const alreadyIn = await join(roomKey, 'pl', { invite: invite.invite });
    const anonymous = await join(roomKey, 'lurker', { accessToken: null, invite: invite.invite });

    expect(invite).toEqual({
      type: 'invite',
      role: 'gm',
      invite: expect.any(String),
      expiresAt: expect.any(Number),
    });
    expect(refused).toEqual({ type: 'invite', role: 'gm', invite: null, expiresAt: null });
    expect(coGm.welcome.role).toBe('gm');
    expect(alreadyIn.welcome.role).toBe('pl');
    expect(anonymous.welcome.role).toBe('guest');
  });

  it('ignores an invite to another room', async () => {
    const roomKey = await createRoom();
    const elsewhere = signToken<'invite'>(
      { aud: 'invite', room: 'another-room', role: 'gm' },
      60,
      SESSION_SECRET,
    );

    const visitor = await join(roomKey, 'visitor', { invite: elsewhere });

    expect(visitor.welcome.role).toBe('pl');
  });
});

describe('the cursor role', () => {
  it('is the role the server gave, whatever the cursor says', async () => {
    const { gm, pl, guest } = await table();

    pl.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('pl', 'gm') }]);

    expect(await pl.events()).toEqual([
      {
        eventName: AuthorityEvent.AUTHORITATIVE,
        data: cursorOf('pl', 'pl'),
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
    for (const other of [gm, guest]) {
      expect((await other.events())[0].data).toEqual(cursorOf('pl', 'pl'));
    }
  });
});

describe('who may sit where', () => {
  it('keeps a guest from going by the user id of someone who came in logged in', async () => {
    const { roomKey } = await table();

    const impostor = await connect(roomKey);
    impostor.hello('mallory', { userId: 'user-pl', accessToken: null });

    expect((await impostor.next('error')).code).toBe('unauthorized');
  });

  it('puts out a guest sitting in the seat of someone logged in once they come', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const squatter = await join(roomKey, 'pl', { userId: 'guest-x', accessToken: null });
    await gm.client.next('join');

    const owner = await join(roomKey, 'pl');

    expect((await squatter.client.next('error')).code).toBe('bad-message');
    expect(owner.welcome.role).toBe('pl');
    expect(await gm.client.next('leave')).toEqual({ type: 'leave', peerId: 'pl' });
    expect((await gm.client.next('join')).member.userId).toBe('user-pl');
  });

  it('lets an invitation work for one who was turned away before getting a seat', async () => {
    const { roomKey, gm } = await table();
    const first = await connect(roomKey);
    first.hello('pl', { userId: 'user-dave', accessToken: accessTokenFor('user-dave') });
    expect((await first.next('error')).code).toBe('bad-message');

    gm.send({ type: 'invite', role: 'gm' });
    const { invite } = await gm.next('invite');
    const again = await join(roomKey, 'dave', { invite });

    expect(again.welcome.role).toBe('gm');
  });
});

describe('whose cursor a seat may write', () => {
  it('lets a player write only its own cursor, as the user it came in as', async () => {
    const { gm, pl, guest } = await table();
    gm.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('gm', 'gm') }]);
    await pl.events();
    await guest.events();

    pl.emit([
      // ほかの人のカーソルに、自分のユーザー ID を書き込もうとする
      {
        eventName: SyncEvent.UPDATE,
        data: {
          ...cursorOf('gm', 'gm', 2),
          syncData: { ...cursorOf('gm', 'gm').syncData, userId: 'user-pl' },
        },
      },
      { eventName: SyncEvent.DELETE, data: { aliasName: 'PeerCursor', identifier: 'cursor-gm' } },
      // 自分のカーソルでも、ほかの人を名乗らせない
      {
        eventName: SyncEvent.UPDATE,
        data: {
          ...cursorOf('pl', 'pl'),
          syncData: { ...cursorOf('pl', 'pl').syncData, userId: 'user-gm' },
        },
      },
    ]);

    const putBack = { sendFrom: AUTHORITY_PEER_ID, eventName: AuthorityEvent.AUTHORITATIVE };
    expect(await pl.events()).toEqual([
      { ...putBack, data: cursorOf('gm', 'gm') },
      { ...putBack, data: cursorOf('gm', 'gm') },
      { ...putBack, data: cursorOf('pl', 'pl') },
    ]);
    expect((await gm.events()).map((event) => event.data)).toEqual([cursorOf('pl', 'pl')]);
  });

  it('keeps a tombstone for whatever is deleted under the name of a cursor', async () => {
    const { gm, pl } = await table();
    gm.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) }]);
    await pl.events();

    pl.emit([
      { eventName: SyncEvent.DELETE, data: { aliasName: 'PeerCursor', identifier: 'piece' } },
    ]);
    await gm.events();
    gm.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) }]);

    expect(await gm.events()).toEqual([
      {
        eventName: SyncEvent.DELETE,
        data: { aliasName: 'character', identifier: 'piece' },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
  });
});

describe('what a guest may write', () => {
  it('writes its own cursor and nobody else’s', async () => {
    const { gm, pl, guest } = await table();
    pl.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('pl', 'pl') }]);
    await gm.events();
    await guest.events();

    guest.emit([
      { eventName: SyncEvent.UPDATE, data: cursorOf('guest', 'guest') },
      { eventName: SyncEvent.UPDATE, data: cursorOf('pl', 'guest', 2) },
    ]);

    expect(await guest.events()).toEqual([
      {
        eventName: AuthorityEvent.AUTHORITATIVE,
        data: cursorOf('pl', 'pl'),
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
    expect((await gm.events()).map((event) => event.data)).toEqual([cursorOf('guest', 'guest')]);
  });

  it('speaks only in a tab open to guests, and edits only its own words', async () => {
    const { gm, pl, guest } = await table();
    gm.emit([
      { eventName: SyncEvent.UPDATE, data: tabOf('open', true) },
      { eventName: SyncEvent.UPDATE, data: tabOf('closed', false) },
      { eventName: SyncEvent.UPDATE, data: messageOf('gm-said', 'open', 'user-gm') },
    ]);
    await pl.events();
    await guest.events();

    guest.emit([
      { eventName: SyncEvent.UPDATE, data: messageOf('said', 'open', 'user-guest') },
      { eventName: SyncEvent.UPDATE, data: messageOf('dice', 'open', 'System-BCDice') },
      { eventName: SyncEvent.UPDATE, data: messageOf('said', 'open', 'user-guest', 2) },
      { eventName: SyncEvent.UPDATE, data: messageOf('hidden', 'closed', 'user-guest') },
      { eventName: SyncEvent.UPDATE, data: messageOf('lost', 'no-such-tab', 'user-guest') },
      { eventName: SyncEvent.UPDATE, data: messageOf('gm-said', 'open', 'user-gm', 2) },
    ]);

    expect((await pl.events()).map((event) => event.data)).toEqual([
      messageOf('said', 'open', 'user-guest'),
      messageOf('dice', 'open', 'System-BCDice'),
      messageOf('said', 'open', 'user-guest', 2),
    ]);
    expect(await guest.events()).toEqual([
      {
        eventName: AuthorityEvent.WITHDRAW,
        data: { identifier: 'hidden' },
        sendFrom: AUTHORITY_PEER_ID,
      },
      {
        eventName: AuthorityEvent.WITHDRAW,
        data: { identifier: 'lost' },
        sendFrom: AUTHORITY_PEER_ID,
      },
      {
        eventName: AuthorityEvent.AUTHORITATIVE,
        data: messageOf('gm-said', 'open', 'user-gm'),
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
  });

  it('may edit words first written under its user id as originFrom', async () => {
    const { gm, pl, guest } = await table();
    const quoted = contextOf(
      'quoted',
      1,
      0.5,
      { parentIdentifier: 'open', attributes: { from: 'System', originFrom: 'user-guest' } },
      'chat',
    );
    gm.emit([
      { eventName: SyncEvent.UPDATE, data: tabOf('open', true) },
      { eventName: SyncEvent.UPDATE, data: quoted },
    ]);
    await pl.events();
    await guest.events();

    guest.emit([{ eventName: SyncEvent.UPDATE, data: { ...quoted, majorVersion: 2 } }]);

    expect((await pl.events())[0].data).toEqual({ ...quoted, majorVersion: 2 });
  });

  it('changes and deletes nothing else, and has it put back on its own screen', async () => {
    const { gm, pl, guest } = await table();
    gm.emit([
      { eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) },
      { eventName: SyncEvent.DELETE, data: { identifier: 'gone' } },
    ]);
    await pl.events();
    await guest.events();
    guest.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('guest', 'guest') }]);
    await gm.events();
    await pl.events();

    guest.emit([
      { eventName: SyncEvent.UPDATE, data: contextOf('piece', 2, 0.5) },
      { eventName: SyncEvent.UPDATE, data: contextOf('gone', 2, 0.5) },
      { eventName: SyncEvent.UPDATE, data: contextOf('new-piece', 1, 0.5) },
      { eventName: SyncEvent.DELETE, data: { identifier: 'piece' } },
      { eventName: SyncEvent.FORGET_DELETED, data: { identifiers: ['gone'] } },
      {
        eventName: SyncEvent.DELETE,
        data: { aliasName: 'PeerCursor', identifier: 'cursor-guest' },
      },
    ]);

    const putBack = { sendFrom: AUTHORITY_PEER_ID };
    expect(await guest.events()).toEqual([
      { ...putBack, eventName: AuthorityEvent.AUTHORITATIVE, data: contextOf('piece', 1, 0.5) },
      { ...putBack, eventName: SyncEvent.DELETE, data: { aliasName: '', identifier: 'gone' } },
      { ...putBack, eventName: AuthorityEvent.WITHDRAW, data: { identifier: 'new-piece' } },
      { ...putBack, eventName: AuthorityEvent.AUTHORITATIVE, data: contextOf('piece', 1, 0.5) },
    ]);
    expect(await pl.events()).toEqual([
      {
        eventName: SyncEvent.DELETE,
        data: { aliasName: 'PeerCursor', identifier: 'cursor-guest' },
        sendFrom: 'guest',
      },
    ]);
  });
});

describe('changing a role', () => {
  it('is for the GM, and moves the cursor to the new role for everyone', async () => {
    const { gm, pl, guest } = await table();
    pl.emit([{ eventName: SyncEvent.UPDATE, data: cursorOf('pl', 'pl', 3) }]);
    await gm.events();
    await guest.events();

    gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'pl', role: 'gm' } }]);

    const promoted = (await pl.events())[0];
    expect(promoted.eventName).toBe(SyncEvent.UPDATE);
    expect(promoted.sendFrom).toBe(AUTHORITY_PEER_ID);
    expect(promoted.data).toEqual({
      ...cursorOf('pl', 'gm', 4),
      minorVersion: expect.any(Number),
    });
    for (const other of [gm, guest]) expect((await other.events())[0]).toEqual(promoted);
    // 置けるかどうかはトークンの役割で決まるので、新しい役割のトークンが届く
    const renewed = await pl.next('asset-token');
    expect(readToken(renewed.assetToken, 'asset', SESSION_SECRET)?.role).toBe('gm');
    expect(renewed.role).toBe('gm');

    // GM が2人になったので、もとの GM は降りられる
    gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'gm', role: 'pl' } }]);
    pl.send({ type: 'invite', role: 'pl' });
    expect((await pl.next('invite')).invite).toEqual(expect.any(String));
  });

  it.each([
    ['asked by a player', 'pl', { peerId: 'gm', role: 'pl' }, 'not-game-master'],
    ['for someone not here', 'gm', { peerId: 'nobody', role: 'pl' }, 'unknown-peer'],
    ['for a guest who has not logged in', 'gm', { peerId: 'guest', role: 'pl' }, 'not-logged-in'],
    [
      'that would leave the room without a GM',
      'gm',
      { peerId: 'gm', role: 'pl' },
      'last-game-master',
    ],
  ] as const)('is refused when %s', async (_name, asker, request, reason) => {
    const clients = await table();

    clients[asker].emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: request }]);

    expect(await clients[asker].events()).toEqual([
      {
        eventName: AuthorityEvent.ROLE_REJECTED,
        data: { ...request, reason },
        sendFrom: AUTHORITY_PEER_ID,
      },
    ]);
  });

  it('passes over a request it cannot read, and relays one meant for another peer', async () => {
    const { gm, pl } = await table();

    gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'pl', role: 'king' } }]);
    gm.emit([{ eventName: AuthorityEvent.ROLE_REQUEST, data: { peerId: 'pl', role: 'gm' } }], 'pl');

    expect(await pl.events()).toEqual([
      {
        eventName: AuthorityEvent.ROLE_REQUEST,
        data: { peerId: 'pl', role: 'gm' },
        sendFrom: 'gm',
      },
    ]);
    await gm.expectQuiet();
  });
});
