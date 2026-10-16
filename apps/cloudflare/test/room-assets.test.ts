import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { roomAssetKey } from '../src/core/assets/keys';
import type { RoomDurableObject } from '../src/rooms/room';
import { ORIGIN, PNG_HEAD, accessTokenFor, freshFile, freshIp } from './shared/helpers';
import { ROOMS, createRoom, join } from './shared/room-helpers';
import { stubOf } from './cf-helpers';

// 部屋が席に渡すアセットのトークンと、部屋が消えるときのアセット

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 部屋のアセットを、そのトークンで置こうとする */
const tryPut = async (roomKey: string, token: string) => {
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
    })
  );
  return { res, id };
};

/** 部屋のアセットを、そのトークンで置く */
const putIn = async (roomKey: string, token: string) => {
  const { res, id } = await tryPut(roomKey, token);
  expect(res.status).toBe(201);
  return id;
};

describe('a room’s assets when the room goes', () => {
  it('take nothing left behind by an upload still under way as the room was deleted', async () => {
    const roomKey = await createRoom({}, 'gm');
    const gm = await join(roomKey, 'gm');
    // 部屋に置けると答えたあと、中身を置ききる前に部屋を削除する
    const put = env.ASSETS.put.bind(env.ASSETS);
    vi.spyOn(env.ASSETS, 'put').mockImplementation(async (...args: Parameters<R2Bucket['put']>) => {
      const deleted = await exports.default.fetch(
        new Request(`${ROOMS}/${roomKey}`, {
          method: 'DELETE',
          headers: {
            Origin: ORIGIN,
            'CF-Connecting-IP': freshIp(),
            Authorization: `Bearer ${accessTokenFor('user-gm')}`,
          },
        })
      );
      expect(deleted.status).toBe(204);
      return put(...args);
    });

    const { res, id } = await tryPut(roomKey, gm.welcome.assetToken);

    expect(res.status).toBe(404);
    expect(await env.ASSETS.head(roomAssetKey(roomKey, id))).toBeNull();
  });

  it('go with the room once it has stood empty past its retention', async () => {
    const roomKey = await createRoom();
    const { client, welcome } = await join(roomKey, 'alice');
    const id = await putIn(roomKey, welcome.assetToken);
    client.close();
    await client.closed;
    await runInDurableObject(stubOf(roomKey), (_instance, state) =>
      state.storage.sql.exec('UPDATE room SET emptied_at = 0')
    );

    expect(await runDurableObjectAlarm(stubOf(roomKey))).toBe(true);

    expect(await env.ASSETS.head(roomAssetKey(roomKey, id))).toBeNull();
  });

  it('do not hold the room up when they cannot be deleted, which the sweep picks up later', async () => {
    const roomKey = await createRoom();
    const { welcome } = await join(roomKey, 'alice');
    await putIn(roomKey, welcome.assetToken);
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await runInDurableObject(stubOf(roomKey), async (instance: RoomDurableObject) => {
      const broken = { list: () => Promise.reject(new Error('R2 down')) };
      (instance as unknown as { env: Env }).env = { ...env, ASSETS: broken } as unknown as Env;
      return instance.deleteRoom('user-host');
    });

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

  it('answers for more rooms than one statement can name', async () => {
    const lobby = env.LOBBY.getByName('lobby');
    const keys = Array.from({ length: 250 }, (_, i) => `known-${String(i).padStart(3, '0')}`);
    await runInDurableObject(lobby, (_instance, state) => {
      for (const key of keys) {
        state.storage.sql.exec(
          `INSERT INTO rooms (room_key, room_id, name, has_password, members, created_at)
           VALUES (?, 'abc', 'r', 0, 0, 0)`,
          key
        );
      }
    });

    try {
      expect(await lobby.known([...keys, 'f'.repeat(32)])).toEqual(keys);
    } finally {
      await runInDurableObject(lobby, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM rooms WHERE room_key LIKE 'known-%'");
      });
    }
  });
});
