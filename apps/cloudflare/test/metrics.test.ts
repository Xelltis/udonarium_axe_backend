import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { AuthorityEvent, SyncEvent } from '../contracts/protocol';
import type { RoomDurableObject } from '../src/rooms/room';
import { FLUSH_TALLY_MS } from '../src/core/rooms/limits';
import {
  chatTabList,
  connect,
  contextOf,
  createRoom,
  eventually,
  join,
  listedTabOf,
} from './shared/room-helpers';
import { stubOf } from './cf-helpers';

/** 部屋が Analytics Engine に書いたものを手元に集める */
const recordPoints = async (roomKey: string) => {
  const points: AnalyticsEngineDataPoint[] = [];
  await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
    const metrics = { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) };
    (instance as unknown as { env: Env }).env = { ...env, METRICS: metrics } as unknown as Env;
  });
  return points;
};

const summary = (points: AnalyticsEngineDataPoint[]) =>
  points.map((point) => [point.blobs?.[1], point.blobs?.[2]]);

describe('room metrics', () => {
  it('writes who came and went, why a socket was closed, what was written and how dice rolled', async () => {
    const roomKey = await createRoom();
    const points = await recordPoints(roomKey);

    const alice = await join(roomKey, 'alice');
    const guest = await join(roomKey, 'guest', { accessToken: null });
    await alice.client.next('join');
    alice.client.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) }]);
    alice.client.emit([
      { eventName: SyncEvent.UPDATE, data: chatTabList() },
      {
        eventName: SyncEvent.UPDATE,
        data: listedTabOf('main', { plCanView: true, guestCanView: true }),
      },
      {
        eventName: AuthorityEvent.ROLL_REQUEST,
        data: {
          message: contextOf('roll', 1, 0.5, { parentIdentifier: 'main' }, 'chat'),
          command: '1d1',
          gameSystem: 'DiceBot',
          speaker: 'Alice',
        },
      },
    ]);
    await guest.client.events();
    await guest.client.events();
    guest.client.send({ type: 'send', events: {} });
    // 部屋が空になると、まとめておいた書き込みの数を記録する
    alice.client.close();
    await eventually(
      async () => points.length,
      (count) => count >= 6,
    );
    await eventually(async () => summary(points).some(([event]) => event === 'flush'), Boolean);

    expect(points[0]).toEqual({
      indexes: [roomKey],
      blobs: ['backend.example', 'join', 'pl'],
      doubles: [1],
    });
    expect(summary(points)).toEqual(
      expect.arrayContaining([
        ['join', 'guest'],
        ['roll', 'DiceBot'],
        ['refuse', 'bad-message'],
        ['leave', 'guest'],
        ['flush', ''],
      ]),
    );
    // 書いたのは4つ（コマ、タブの一覧、タブ、振った結果）。それぞれの行と、その主キーの索引の行を書く
    const flush = points.find((point) => point.blobs?.[1] === 'flush');
    expect(flush?.doubles?.[0]).toBe(8);
  });

  it('writes the number of changes once a minute while people play', async () => {
    const roomKey = await createRoom();
    const points = await recordPoints(roomKey);
    const alice = await join(roomKey, 'alice');
    await runInDurableObject(stubOf(roomKey), (instance: RoomDurableObject) => {
      (
        instance as unknown as { engine: { flushTally: { count: number; since: number } } }
      ).engine.flushTally = {
        count: 3,
        since: Date.now() - FLUSH_TALLY_MS,
      };
    });

    alice.client.emit([{ eventName: SyncEvent.UPDATE, data: contextOf('piece', 1, 0.5) }]);
    await eventually(async () => summary(points).some(([event]) => event === 'flush'), Boolean);

    // 前からの3行に、1つのものの行と索引の行
    expect(points.find((point) => point.blobs?.[1] === 'flush')?.doubles).toEqual([5]);
  });

  it('writes nothing once the room is gone', async () => {
    const roomKey = await createRoom();
    const late = await connect(roomKey);
    const points = await recordPoints(roomKey);
    await runDurableObjectAlarm(stubOf(roomKey));

    late.hello('late');
    await late.next('error');

    expect(points).toEqual([]);
  });
});
