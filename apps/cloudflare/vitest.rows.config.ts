import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// `npm run rows`: the report of the rows a room reads and writes (test/rows/rows.report.ts). It is slow
// and prints numbers rather than checking them, so it is kept out of npm test.
//   ROWS_SCALES=small,session,max  the rooms to try (max holds about 200,000 objects and is slow)
//   ROWS_REPEAT=5                  how many times each flow is timed
//   ROWS_ALARMS_PER_HOUR=1         how often the patrol alarm fires in the session worked out
//   ROWS_PAGE_KIB=16               the size of the store's pages to try

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  define: {
    __ROWS_SCALES__: JSON.stringify(process.env.ROWS_SCALES ?? 'small,session'),
    __ROWS_REPEAT__: Number(process.env.ROWS_REPEAT ?? 3),
    // Measured in production on 2026-10-26: 21 alarms in 2 hours, with 3 people logged in.
    __ROWS_ALARMS_PER_HOUR__: Number(process.env.ROWS_ALARMS_PER_HOUR ?? 12),
    __ROWS_PAGE_KIB__: Number(process.env.ROWS_PAGE_KIB ?? 0),
  },
  test: {
    include: ['test/rows/**/*.report.ts'],
    testTimeout: 30 * 60 * 1000,
    reporters: ['verbose'],
  },
});
