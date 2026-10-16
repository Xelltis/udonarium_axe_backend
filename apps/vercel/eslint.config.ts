import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier/recommended';

export default defineConfig([
  { ignores: ['node_modules', 'dist', 'build', 'coverage', '.vercel', '.esm-check'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  // Last, so formatting is checked with the rest and no rule above fights Prettier over it.
  prettierPlugin,
]);
