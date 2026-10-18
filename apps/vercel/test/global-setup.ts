import { createClient } from 'redis';

/** The tests use Redis. When it cannot be reached, stops and says how to start one. */
export default async () => {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const redis = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 2000 } });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    throw new Error(`The tests need Redis at ${url}. Start one with \`docker compose up -d redis\` in apps/vercel.`);
  } finally {
    if (redis.isOpen) redis.destroy();
  }
};
