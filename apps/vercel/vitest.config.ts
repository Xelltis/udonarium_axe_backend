import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // 共有のテストと、それが確かめる src/core は、部屋のサーバーがこのアプリで動くまで外しておく
    exclude: ['test/shared/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcovonly', 'html'],
      include: ['src/**/*.{ts,js}', 'api/**/*.{ts,js}'],
      exclude: ['src/**/types.ts', 'src/http/context.ts', 'src/core/**'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
