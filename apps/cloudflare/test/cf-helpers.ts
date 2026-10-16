import { env } from 'cloudflare:test';

// Cloudflare 版だけのテストが、部屋の Durable Object に直に触るとき

export const stubOf = (roomKey: string) => env.ROOMS.getByName(roomKey);
