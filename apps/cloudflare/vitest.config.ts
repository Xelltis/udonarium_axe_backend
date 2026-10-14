import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { ACCESS_CONTROL_ALLOW_ORIGIN: 'https://app.example,http://localhost:4200' },
        // テストでは上限を小さくして、429 を数回のリクエストで確かめる
        ratelimits: {
          UPLOAD_LIMITER: { namespace_id: '1001', simple: { limit: 5, period: 60 } },
          READ_LIMITER: { namespace_id: '1002', simple: { limit: 5, period: 60 } },
          ROOM_LIMITER: { namespace_id: '1003', simple: { limit: 5, period: 60 } },
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      // workerd の中では V8 のカバレッジを取れないので istanbul を使う
      provider: 'istanbul',
      reporter: ['text', 'lcovonly'],
      include: ['src/**/*.ts', 'contracts/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/http/context.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
