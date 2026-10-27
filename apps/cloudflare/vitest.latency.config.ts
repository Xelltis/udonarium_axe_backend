import { defineConfig } from 'vitest/config';

// `npm run latency`: how long people in a room on `wrangler dev` wait (test/latency/room.latency.ts).
// It starts its own dev server, takes minutes and prints numbers rather than checking them, so it is
// kept out of npm test. Compare its numbers before and after a change on the same machine.
//   LATENCY_SCALES=small,session  the rooms to try (see test/rows/room-model.ts)
//   LATENCY_RUNS=5                how many times each room is tried; the median is shown

export default defineConfig({
  define: {
    __LATENCY_SCALES__: JSON.stringify(process.env.LATENCY_SCALES ?? 'small,session'),
    __LATENCY_RUNS__: Number(process.env.LATENCY_RUNS ?? 5),
  },
  test: {
    include: ['test/latency/**/*.latency.ts'],
    environment: 'node',
    globalSetup: ['test/latency/dev-server.mjs'],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 3 * 60 * 1000,
    reporters: ['verbose'],
  },
});
