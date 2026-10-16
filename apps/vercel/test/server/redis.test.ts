import { describe, expect, it, vi } from 'vitest';

import { binaryOf, keyOf } from '../../src/server/redis.js';
import { freshKey, useRedis } from './redis-helpers.js';

const connection = useRedis();

describe('the Redis connection', () => {
  it('reads values back as bytes through its binary view', async () => {
    const key = freshKey()('bytes');
    const bytes = Buffer.from([0, 1, 254, 255]);
    await connection.redis.set(key, bytes);

    expect(await binaryOf(connection.redis).get(key)).toEqual(bytes);
    expect(typeof (await connection.redis.get(key))).toBe('string');
  });

  it('logs what goes wrong on the connection', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    connection.redis.emit('error', new Error('down'));
    expect(error).toHaveBeenCalledWith('Redis error:', expect.any(Error));
    error.mockRestore();
  });

  it('names keys under the prefix', () => {
    expect(keyOf('axe:')('r', 'abc', 'meta')).toBe('axe:r:abc:meta');
  });
});
