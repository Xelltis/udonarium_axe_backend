import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { roomAssetKey } from '../src/assets/keys';
import { ASSET_TOKEN_SECONDS, readToken } from '../src/auth/tokens';
import type { RoomDurableObject } from '../src/rooms/room';
import { ORIGIN, PNG_HEAD, SESSION_SECRET, accessTokenFor, freshFile, freshIp } from './helpers';
import { ROOMS, createRoom, join, stubOf } from './room-helpers';

// 部屋が席に渡すアセットのトークンと、部屋が消えるときのアセット

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const claimsOf = (token: string) => readToken(token, 'asset', SESSION_SECRET);

/** 部屋のアセットを、そのトークンで置く */
const putIn = async (roomKey: string, token: string) => {
  const { file, id } = await freshFile(PNG_HEAD, 128);
  const res = await exports.default.fetch(
    new Request(`${ROOMS}/${roomKey}/assets/${id}`, {
      method: 'PUT',
      body: file,
      headers: {
        Origin: ORIGIN,
        'Content-Length': String(file.byteLength),
        'CF-Connecting-IP': freshIp(),
        Authorization: `Bearer ${token}`,
      },
    }),
  );
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
      expect(seat.welcome.assetTokenExpiresAt).toBeGreaterThan(
        now + (ASSET_TOKEN_SECONDS - 5) * 1000,
      );
      expect(seat.welcome.assetTokenExpiresAt).toBeLessThanOrEqual(
        now + ASSET_TOKEN_SECONDS * 1000,
      );
    }
  });

  it('is handed again when asked for, before it runs out', async () => {
    const roomKey = await createRoom();
    const { client } = await join(roomKey, 'alice');

    client.send({ type: 'asset-token' });
    const renewed = await client.next('asset-token');

    expect(claimsOf(renewed.assetToken)).toMatchObject({ room: roomKey, role: 'pl' });
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
  });

  it('lets its holder put pictures up in the room', async () => {
    const roomKey = await createRoom();
    const { welcome } = await join(roomKey, 'alice');

    const id = await putIn(roomKey, welcome.assetToken);

    expect(await env.ASSETS.head(roomAssetKey(roomKey, id))).not.toBeNull();
  });
});

describe('a room’s assets when the room goes', () => {
  it('go with the room when its GM deletes it, and no other room’s go with them', async () => {
    const roomKey = await createRoom({}, 'gm');
    const other = await createRoom({}, 'other-gm');
    const { welcome } = await join(roomKey, 'gm');
    const { welcome: otherWelcome } = await join(other, 'other-gm');
    const ids = [
      await putIn(roomKey, welcome.assetToken),
      await putIn(roomKey, welcome.assetToken),
    ];
    const kept = await putIn(other, otherWelcome.assetToken);

    const res = await exports.default.fetch(
      new Request(`${ROOMS}/${roomKey}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          'CF-Connecting-IP': freshIp(),
          Authorization: `Bearer ${accessTokenFor('user-gm')}`,
        },
      }),
    );

    expect(res.status).toBe(204);
    for (const id of ids) expect(await env.ASSETS.head(roomAssetKey(roomKey, id))).toBeNull();
    expect(await env.ASSETS.head(roomAssetKey(other, kept))).not.toBeNull();
  });

  it('go with the room once it has stood empty past its retention', async () => {
    const roomKey = await createRoom();
    const { client, welcome } = await join(roomKey, 'alice');
    const id = await putIn(roomKey, welcome.assetToken);
    client.close();
    await client.closed;
    await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      state.storage.sql.exec('UPDATE room SET emptied_at = 0'),
    );

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);

    expect(await env.ASSETS.head(roomAssetKey(roomKey, id))).toBeNull();
  });

  it('do not hold the room up when they cannot be deleted, which the sweep picks up later', async () => {
    const roomKey = await createRoom();
    const { welcome } = await join(roomKey, 'alice');
    await putIn(roomKey, welcome.assetToken);
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await runInDurableObject(
      stubOf(roomKey),
      async (instance: RoomDurableObject) => {
        const broken = { list: () => Promise.reject(new Error('R2 down')) };
        (instance as unknown as { env: Env }).env = { ...env, ASSETS: broken } as unknown as Env;
        return instance.deleteRoom('user-host');
      },
    );

    expect(outcome).toBe('deleted');
    expect(failure).toHaveBeenCalledWith('Room asset deletion failed:', expect.any(Error));
  });
});

describe('the lobby’s view of which rooms are still there', () => {
  it('names the rooms it lists among those it is asked about', async () => {
    const roomKey = await createRoom();
    const lobby = env.LOBBY.getByName('lobby');

    expect(await lobby.known([roomKey, 'f'.repeat(32)])).toEqual([roomKey]);
    expect(await lobby.known([])).toEqual([]);
  });
});
