import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Relay } from '../../../src/server/rooms/relay.js';
import { freshKey, useRedis } from '../redis-helpers.js';

const connection = useRedis();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the relay between instances', () => {
  it('starts once, and says the instance is alive until it stops', async () => {
    const relay = new Relay(connection.redis, freshKey(), 'here');
    const duplicate = vi.spyOn(connection.redis, 'duplicate');

    await relay.start();
    await relay.start();

    expect(duplicate).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await relay.isAlive('here')).toBe(true));
    await relay.stop();
    expect(await relay.isAlive('here')).toBe(false);
  });

  it('says what goes wrong on the connection it hears on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const relay = new Relay(connection.redis, freshKey(), 'here');
    await relay.start();
    const { subscriber } = relay as unknown as { subscriber: EventEmitter };

    subscriber.emit('error', new Error('reset'));

    expect(error).toHaveBeenCalledWith('Redis subscriber error:', expect.any(Error));
    await relay.stop();
  });

  it('hears on a channel listened to again before the stops of listening there are through', async () => {
    const relay = new Relay(connection.redis, freshKey(), 'here');
    await relay.start();
    const channel = relay.controlOf('room');
    const heard: string[] = [];
    await relay.subscribe(channel, () => heard.push('first'));

    void relay.unsubscribe(channel);
    void relay.unsubscribe(channel);
    await relay.subscribe(channel, () => heard.push('second'));
    await relay.publish(channel, { t: 'moved' });

    await vi.waitFor(() => expect(heard).toEqual(['second']));
    await relay.stop();
  });

  it('keeps saying the instance is alive, and says so when it cannot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const set = vi.spyOn(connection.redis, 'set').mockRejectedValue(new Error('down'));
    const relay = new Relay(connection.redis, freshKey(), 'here', { ttlMs: 1000, heartbeatMs: 20 });

    await relay.start();

    await vi.waitFor(() => expect(set.mock.calls.length).toBeGreaterThan(1));
    expect(error).toHaveBeenCalledWith('Could not say this instance is alive:', expect.any(Error));
    vi.restoreAllMocks();
    await relay.stop();
  });
});
