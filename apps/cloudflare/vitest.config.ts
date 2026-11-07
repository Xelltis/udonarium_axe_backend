import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Keeps wrangler to its warnings and errors, so that the tests' output holds only the tests. At its
// default level it says each time that it read .dev.vars, the secrets for npm run dev (the
// bindings below stand in for them).
process.env.WRANGLER_LOG ??= 'warn';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example,http://localhost:4200',
          DISCORD_CLIENT_ID: 'test-client',
          DISCORD_CLIENT_SECRET: 'test-client-secret',
          SESSION_SECRET: 'test-session-secret-0123456789abcdef',
          ADMIN_DISCORD_IDS: '100000000000000001',
        },
        // The tests use smaller limits, to see a 429 within a few requests.
        ratelimits: {
          UPLOAD_LIMITER: { namespace_id: '1001', simple: { limit: 5, period: 60 } },
          READ_LIMITER: { namespace_id: '1002', simple: { limit: 5, period: 60 } },
          ROOM_LIMITER: { namespace_id: '1003', simple: { limit: 5, period: 60 } },
          AUTH_LIMITER: { namespace_id: '1004', simple: { limit: 5, period: 60 } },
        },
      },
    }),
  ],
  test: {
    // The test files of a worker share their modules and their storage, which Vitest's performance
    // guide gives as the faster set-up for tests that do not rely on a clean state. The tests keep
    // to keys of their own, and spies are put back before each test.
    isolate: false,
    restoreMocks: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      // V8 coverage cannot be taken inside workerd, so istanbul is used.
      provider: 'istanbul',
      reporter: ['text', 'lcovonly'],
      include: ['src/**/*.ts', 'contracts/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.generated.ts', 'src/http/context.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
