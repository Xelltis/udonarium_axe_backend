import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_LISTED_ROOMS, redisLobby } from '../../src/server/lobby.js';
import { freshKey, useRedis } from './redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

const room = (roomKey: string, members = 0) => ({
  roomKey,
  roomId: 'abc',
  name: `room ${roomKey}`,
  hasPassword: roomKey.endsWith('locked'),
  members,
});

describe('a Redis lobby', () => {
  it('lists rooms newest first, and rooms made at the same moment by their keys', async () => {
    const lobby = redisLobby(connection.redis, freshKey());
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    await lobby.register(room('b'));
    await lobby.register(room('a-locked'));
    now.mockReturnValue(2000);
    await lobby.register(room('c', 2));

    expect(await lobby.list()).toEqual([
      { roomKey: 'c', roomId: 'abc', name: 'room c', hasPassword: false, members: 2 },
      { roomKey: 'a-locked', roomId: 'abc', name: 'room a-locked', hasPassword: true, members: 0 },
      { roomKey: 'b', roomId: 'abc', name: 'room b', hasPassword: false, members: 0 },
    ]);
  });

  it('marks the rooms of their GM, and keeps them listed past the newest ones', async () => {
    const key = freshKey();
    const lobby = redisLobby(connection.redis, key);
    vi.spyOn(Date, 'now').mockReturnValue(1);
    await lobby.register(room('old'));
    await lobby.setGameMasters('old', ['gm']);
    vi.restoreAllMocks();
    const newer = Array.from({ length: MAX_LISTED_ROOMS }, (_, i) => ({
      score: Date.now() + i,
      value: `newer-${i}`,
    }));
    await connection.redis.zAdd(key('lobby', 'rooms'), newer);
    await connection.redis.hSet(
      key('lobby', 'meta'),
      Object.fromEntries(newer.map(({ value }) => [value, JSON.stringify(room(value))])),
    );

    const anybody = await lobby.list();
    const mine = await lobby.list('gm');

    expect(anybody).toHaveLength(MAX_LISTED_ROOMS);
    expect(anybody.some((summary) => summary.roomKey === 'old')).toBe(false);
    expect(mine.at(-1)).toMatchObject({ roomKey: 'old', deletable: true });
    expect(await lobby.list('nobody')).toHaveLength(MAX_LISTED_ROOMS);
  });

  it('finds one room by its key, marked for its GM, and nothing for a key it lacks', async () => {
    const lobby = redisLobby(connection.redis, freshKey());
    await lobby.register(room('found'));
    await lobby.setGameMasters('found', ['gm']);

    expect(await lobby.find('found')).toEqual(room('found'));
    expect(await lobby.find('found', 'gm')).toEqual({ ...room('found'), deletable: true });
    expect(await lobby.find('missing', 'gm')).toBeNull();
  });

  it('counts members and follows the GMs only while the room is listed', async () => {
    const lobby = redisLobby(connection.redis, freshKey());
    await lobby.register(room('here'));
    await lobby.setMembers('here', 3);
    await lobby.setGameMasters('here', ['first', 'second']);
    await lobby.setGameMasters('here', ['second']);

    await lobby.setMembers('gone', 5);
    await lobby.setGameMasters('gone', ['first']);

    expect((await lobby.find('here', 'second'))?.members).toBe(3);
    expect(await lobby.find('here', 'second')).toHaveProperty('deletable', true);
    expect(await lobby.find('here', 'first')).not.toHaveProperty('deletable');
    expect(await lobby.list('first')).toEqual([{ ...room('here'), members: 3 }]);
  });

  it('takes a removed room out of the list, its GMs and its members', async () => {
    const lobby = redisLobby(connection.redis, freshKey());
    await lobby.register(room('kept'));
    await lobby.register(room('removed', 1));
    await lobby.setGameMasters('removed', ['gm']);

    await lobby.remove('removed');
    await lobby.remove('never-there');

    expect((await lobby.list('gm')).map((summary) => summary.roomKey)).toEqual(['kept']);
    expect(await lobby.find('removed')).toBeNull();
  });

  it('lists nothing while no room is open', async () => {
    expect(await redisLobby(connection.redis, freshKey()).list('gm')).toEqual([]);
  });

  it('names which of the keys asked about are listed', async () => {
    const lobby = redisLobby(connection.redis, freshKey());
    await lobby.register(room('one'));
    await lobby.register(room('two'));

    expect(await lobby.known(['one', 'three', 'two'])).toEqual(['one', 'two']);
    expect(await lobby.known([])).toEqual([]);
  });

  it('leaves out a listed key whose summary has gone', async () => {
    const key = freshKey();
    const lobby = redisLobby(connection.redis, key);
    await lobby.register(room('half'));
    await connection.redis.hDel(key('lobby', 'meta'), 'half');
    await connection.redis.hDel(key('lobby', 'members'), 'half');

    expect(await lobby.list()).toEqual([]);
  });
});
