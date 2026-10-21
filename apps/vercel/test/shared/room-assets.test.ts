import { afterEach, describe, expect, it, vi } from 'vitest';

import { ASSET_TOKEN_SECONDS, readToken } from '../../src/core/auth/tokens.js';
import { harness } from '../harness.js';
import {
  ORIGIN,
  OTHER_ROOM_KEY,
  PNG_HEAD,
  SESSION_SECRET,
  accessTokenFor,
  assetTokenFor,
  freshFile,
  freshIp,
} from './helpers.js';
import { ROOMS, createRoom, eventually, join } from './room-helpers.js';

// The asset tokens a room hands its seats, and the assets when a room goes.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const claimsOf = (token: string) => readToken(token, 'asset', SESSION_SECRET);

/** Tries to store a room asset with the given token. */
const tryPut = async (roomKey: string, token: string) => {
  const { file, id } = await freshFile(PNG_HEAD, 128);
  const res = await harness.fetch(
    new Request(`${ROOMS}/${roomKey}/assets/${id}`, {
      method: 'PUT',
      body: file,
      headers: {
        Origin: ORIGIN,
        'Content-Length': String(file.byteLength),
        'CF-Connecting-IP': freshIp(),
        Authorization: `Bearer ${token}`,
      },
    })
  );
  return { res, id };
};

/** Stores a room asset with the given token. */
const putIn = async (roomKey: string, token: string) => {
  const { res, id } = await tryPut(roomKey, token);
  expect(res.status).toBe(201);
  return id;
};

describe('the asset token a room hands its seats', () => {
  it('comes with the welcome, for this room and the role the seat was given', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    const guest = await join(roomKey, 'guest', { accessToken: null });

    const now = Date.now();
    for (const [seat, role] of [
      [gm, 'gm'],
      [pl, 'pl'],
      [guest, 'guest'],
    ] as const) {
      expect(claimsOf(seat.welcome.assetToken)).toMatchObject({
        aud: 'asset',
        room: roomKey,
        role,
      });
      expect(seat.welcome.assetTokenExpiresAt).toBeGreaterThan(now + (ASSET_TOKEN_SECONDS - 5) * 1000);
      expect(seat.welcome.assetTokenExpiresAt).toBeLessThanOrEqual(now + ASSET_TOKEN_SECONDS * 1000);
    }
  });

  it('is handed again when asked for, before it runs out', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');

    client.send({ type: 'asset-token' });
    const renewed = await client.next('asset-token');

    expect(claimsOf(renewed.assetToken)).toMatchObject({ room: roomKey, role: 'pl' });
    expect(renewed.role).toBe('pl');
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
  });

  it('lets its holder put pictures up in the room', async () => {
    const roomKey = await createRoom();
    const { welcome } = await join(roomKey, 'alice');

    const id = await putIn(roomKey, welcome.assetToken);

    expect(await harness.assetStored(roomKey, id)).not.toBeNull();
  });

  it('puts nothing up for a seat made a guest, whatever its token says', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    gm.client.emit([{ eventName: 'ROLE_REQUEST', data: { peerId: 'pl', role: 'guest' } }]);
    await pl.client.next('asset-token');

    const { res } = await tryPut(roomKey, pl.welcome.assetToken);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not-a-player' });
  });

  it('puts nothing up for a player who has left the room, though the token has time to run', async () => {
    const roomKey = await createRoom({}, 'gm');
    await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    pl.client.close();
    await eventually(
      () => harness.canUpload(roomKey, 'user-pl'),
      (answer) => answer === 'not-a-player'
    );

    const { res } = await tryPut(roomKey, pl.welcome.assetToken);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not-a-player' });
  });

  it('puts nothing up once the room is gone, whatever the token says', async () => {
    const roomKey = await createRoom({}, 'gm');
    const { welcome } = await join(roomKey, 'gm');
    await harness.fetch(
      new Request(`${ROOMS}/${roomKey}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${accessTokenFor('user-gm')}`,
        },
      })
    );

    const { res, id } = await tryPut(roomKey, welcome.assetToken);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'room-not-found' });
    expect(await harness.assetStored(roomKey, id)).toBeNull();
  });
});

describe('taking an asset out of a room', () => {
  /** Asks to take the asset out of the room, with the given token or none. */
  const tryDelete = (roomKey: string, id: string, token: string | null) =>
    harness.fetch(
      new Request(`${ROOMS}/${roomKey}/assets/${id}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
    );

  it('lets the room’s GM take out what a player put up, and answers the same when it is not there', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    const id = await putIn(roomKey, pl.welcome.assetToken);

    const res = await tryDelete(roomKey, id, gm.welcome.assetToken);

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await harness.assetStored(roomKey, id)).toBeNull();
    expect((await tryDelete(roomKey, id, gm.welcome.assetToken)).status).toBe(204);
  });

  it('takes nothing out for a player, whatever its token says', async () => {
    const roomKey = await createRoom({}, 'gm');
    await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    const id = await putIn(roomKey, pl.welcome.assetToken);

    for (const token of [
      pl.welcome.assetToken,
      assetTokenFor('gm', roomKey, ASSET_TOKEN_SECONDS, 'user-pl'),
      // A guest's token, even under the GM's user id.
      assetTokenFor('guest', roomKey, ASSET_TOKEN_SECONDS, 'user-gm'),
    ]) {
      const res = await tryDelete(roomKey, id, token);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not-game-master' });
    }
    expect(await harness.assetStored(roomKey, id)).not.toBeNull();
  });

  it('takes nothing out for a GM who has left the room, though the token has time to run', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    const pl = await join(roomKey, 'pl');
    const id = await putIn(roomKey, pl.welcome.assetToken);
    gm.client.close();
    await eventually(
      () => harness.canUpload(roomKey, 'user-gm'),
      (answer) => answer === 'not-a-player'
    );

    const res = await tryDelete(roomKey, id, gm.welcome.assetToken);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not-game-master' });
  });

  it('answers room-not-found once the room is gone', async () => {
    const roomKey = await createRoom({}, 'gm');
    const { welcome } = await join(roomKey, 'gm');
    await harness.fetch(
      new Request(`${ROOMS}/${roomKey}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${accessTokenFor('user-gm')}`,
        },
      })
    );

    const res = await tryDelete(roomKey, 'a'.repeat(64), welcome.assetToken);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'room-not-found' });
  });

  it('turns away a request without the room’s token, or for an id that is not one', async () => {
    const roomKey = await createRoom({}, 'gm');
    const { welcome } = await join(roomKey, 'gm');

    const answers = [
      await tryDelete(roomKey, 'a'.repeat(64), null),
      await tryDelete(roomKey, 'a'.repeat(64), assetTokenFor('gm', OTHER_ROOM_KEY, ASSET_TOKEN_SECONDS, 'user-gm')),
      await tryDelete(roomKey, 'not-an-id', welcome.assetToken),
      await tryDelete('not-a-room', 'a'.repeat(64), welcome.assetToken),
    ];

    expect(await Promise.all(answers.map(async (res) => [res.status, await res.json()]))).toEqual([
      [401, { error: 'asset-token-required' }],
      [401, { error: 'asset-token-required' }],
      [400, { error: 'invalid-id' }],
      [400, { error: 'invalid-id' }],
    ]);
  });
});

describe('a room’s assets when the room goes', () => {
  it('go with the room when its GM deletes it, and no other room’s go with them', async () => {
    const roomKey = await createRoom({}, 'gm');
    const other = await createRoom({}, 'other-gm');
    const { welcome } = await join(roomKey, 'gm');
    const { welcome: otherWelcome } = await join(other, 'other-gm');
    const ids = [await putIn(roomKey, welcome.assetToken), await putIn(roomKey, welcome.assetToken)];
    const kept = await putIn(other, otherWelcome.assetToken);

    const res = await harness.fetch(
      new Request(`${ROOMS}/${roomKey}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${accessTokenFor('user-gm')}`,
        },
      })
    );

    expect(res.status).toBe(204);
    for (const id of ids) expect(await harness.assetStored(roomKey, id)).toBeNull();
    expect(await harness.assetStored(other, kept)).not.toBeNull();
  });
});
