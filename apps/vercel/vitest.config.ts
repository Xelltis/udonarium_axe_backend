import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The test files of a worker share one module graph, imported once, and run in threads: the
    // fastest set-up Vitest's performance guide gives, for tests that do not rely on a clean module
    // state. Each file closes what it opened (test/setup.ts), and stubbed environment variables and
    // spies are put back before each test.
    pool: 'threads',
    isolate: false,
    unstubEnvs: true,
    restoreMocks: true,
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'lcovonly', 'html'],
      include: ['src/**/*.{ts,js}', 'api/**/*.{ts,js}'],
      exclude: ['src/**/types.ts', 'src/http/context.ts', 'src/core/**/*.generated.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
