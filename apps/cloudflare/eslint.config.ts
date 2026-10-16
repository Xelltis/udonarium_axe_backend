import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier/recommended';

export default defineConfig([
  { ignores: ['node_modules', 'dist', 'build', 'coverage', '.wrangler'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  {
    // src/core, contracts and test/shared are copied to the Vercel version too, where Node reads them as
    // they are. Node does not fill in extensions.
    files: ['src/core/**/*.ts', 'contracts/**/*.ts', 'test/shared/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['ImportDeclaration', 'ImportExpression', 'ExportNamedDeclaration', 'ExportAllDeclaration'].map((node) => ({
          selector: `${node}[source.value=/^\\.{1,2}\\/(?!.*\\.(js|json)$)/]`,
          message: 'Shared code also runs on Node: end relative imports with .js',
        })),
      ],
    },
  },
  // Last, so formatting is checked with the rest and no rule above fights Prettier over it.
  prettierPlugin,
]);
