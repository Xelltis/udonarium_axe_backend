import { env } from 'cloudflare:test';

// For when a test of the Cloudflare version alone touches a room's Durable Object directly.

export const stubOf = (roomKey: string) => env.ROOMS.getByName(roomKey);
