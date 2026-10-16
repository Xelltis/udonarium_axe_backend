import { describe, expect, it } from 'vitest';

import http from '../../contracts/fixtures/http.json' with { type: 'json' };
import { callApi, logIn } from './auth-helpers.js';
import { ROOM_KEY, accessTokenFor, assetTokenFor, freshFile, put } from './helpers.js';
import { createRoom, prepareAssetRooms } from './room-helpers.js';

// HTTP の返事が、contracts/fixtures/http.json の例と同じ形かを、実際に呼んで確かめる

/**
 * 値の形。キーと値の型を並べたもの。配列は1つ目の形。null は文字列とみなす（契約で null になるのは、
 * 無いかもしれない文字列だけ）
 */
const shapeOf = (value: unknown): unknown => {
  if (value === null) return 'string';
  if (Array.isArray(value)) return [shapeOf(value[0])];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item)]),
    );
  }
  return typeof value;
};

describe('the HTTP contract', () => {
  it('opens a room as the example says', async () => {
    const res = await callApi('/v1/rooms', {
      method: 'POST',
      token: accessTokenFor('user-shape'),
      body: http.createRoomRequest,
    });
    expect(shapeOf(await res.json())).toEqual(shapeOf(http.createRoomResponse));
  });

  it('lists rooms as the example says, with and without the delete mark', async () => {
    const mine = await createRoom({}, 'shape-gm');
    const theirs = await createRoom({}, 'shape-other');

    const res = await callApi('/v1/rooms', { token: accessTokenFor('user-shape-gm') });
    const { rooms } = await res.json<{ rooms: { roomKey: string }[] }>();

    expect(shapeOf(rooms.find((room) => room.roomKey === mine))).toEqual(
      shapeOf(http.roomList.rooms[0]),
    );
    expect(shapeOf(rooms.find((room) => room.roomKey === theirs))).toEqual(
      shapeOf(http.roomList.rooms[1]),
    );
  });

  it('finds a room by its key as the example says', async () => {
    const mine = await createRoom({}, 'shape-finder');

    const res = await callApi(`/v1/rooms/${mine}`, { token: accessTokenFor('user-shape-finder') });

    expect(shapeOf(await res.json())).toEqual(shapeOf(http.room));
  });

  it('tells its login, the tokens and the account as the examples say', async () => {
    const config = await callApi('/v1/auth/config');
    const tokens = await logIn({ id: '77', username: 'shape' });
    const account = await callApi('/v1/account', { token: tokens.accessToken });

    expect(shapeOf(await config.json())).toEqual(shapeOf(http.authConfig));
    expect(shapeOf(tokens)).toEqual(shapeOf(http.tokenResponse));
    expect(shapeOf(await account.json())).toEqual(shapeOf(http.account));
  });

  it('stores, finds and lists assets as the examples say', async () => {
    await prepareAssetRooms();
    const { file, id } = await freshFile();
    const stored = await put(id, file, { 'X-Asset-Name': 'shape.png' });
    const again = await put(id, file);
    const listed = await callApi(`/v1/rooms/${ROOM_KEY}/assets`, { token: assetTokenFor('guest') });

    expect(shapeOf(await stored.json())).toEqual(shapeOf(http.assetStored));
    expect(shapeOf(await again.json())).toEqual(shapeOf(http.assetExists));
    expect(shapeOf(await listed.json())).toEqual(shapeOf(http.roomAssetList));
  });

  it('answers an error as the example says', async () => {
    const res = await callApi(`/v1/rooms/${'0'.repeat(32)}`, {
      method: 'DELETE',
      token: accessTokenFor('user-shape'),
    });
    expect(res.status).toBe(404);
    expect(shapeOf(await res.json())).toEqual(shapeOf(http.error));
  });
});
