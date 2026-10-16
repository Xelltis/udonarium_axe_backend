import { describe, expect, it } from 'vitest';

import { LIMITS, LIMIT_WINDOW_MS, clientIpOf, redisLimiter } from '../../src/server/limits.js';
import { freshKey, useRedis } from './redis-helpers.js';

const connection = useRedis();

const FIVE = { upload: 5, read: 5, room: 5, auth: 5 };

const request = (headers: Record<string, string>, host = 'backend.example') =>
  new Request(`https://${host}/v1/rooms`, { headers });

const statuses = async (allowed: () => Promise<boolean>, times = 6) => {
  const answers: boolean[] = [];
  for (let i = 0; i < times; i++) answers.push(await allowed());
  return answers;
};

describe('clientIpOf', () => {
  it.each([
    [{ 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '198.51.100.1' }, '192.0.2.1'],
    [{ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }, '198.51.100.1'],
    [{}, 'unknown'],
  ])('reads %o as %s', (headers, ip) => {
    expect(clientIpOf(request(headers))).toBe(ip);
  });
});

describe('redisLimiter', () => {
  it('lets one sender through up to its share, then holds it back', async () => {
    const limit = redisLimiter(connection.redis, freshKey(), FIVE);
    const sender = request({ 'x-real-ip': '192.0.2.10' });

    expect(await statuses(() => limit(sender, 'room'))).toEqual([true, true, true, true, true, false]);
  });

  it('counts every IPv6 address in a /64 as one sender, and each kind apart', async () => {
    const limit = redisLimiter(connection.redis, freshKey(), FIVE);
    let i = 0;
    const next = () => request({ 'x-real-ip': `2001:db8:1:2::${++i}` });

    expect(await statuses(() => limit(next(), 'upload'))).toEqual([true, true, true, true, true, false]);
    expect(await limit(next(), 'read')).toBe(true);
  });

  it('counts apart for another host on the same Redis', async () => {
    const limit = redisLimiter(connection.redis, freshKey(), FIVE);
    const headers = { 'x-real-ip': '192.0.2.20' };
    await statuses(() => limit(request(headers), 'auth'), 5);

    expect(await limit(request(headers), 'auth')).toBe(false);
    expect(await limit(request(headers, 'other.example'), 'auth')).toBe(true);
  });

  it('forgets a sender once its window has passed', async () => {
    const key = freshKey();
    const limit = redisLimiter(connection.redis, key);
    await limit(request({ 'x-real-ip': '192.0.2.30' }), 'read');

    const ttl = await connection.redis.pTTL(key('rl', 'read', 'backend.example', '192.0.2.30'));

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LIMIT_WINDOW_MS);
    expect(LIMITS).toEqual({ upload: 100, read: 600, room: 30, auth: 60 });
  });
});
