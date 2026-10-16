import { defineConfig } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default defineConfig([
  { ignores: ['node_modules', 'dist', 'build', 'coverage', '.wrangler'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  eslintConfigPrettier,
  {
    // src/core・contracts・test/shared は Vercel 版にも写し、Node がそのまま読む。Node は拡張子を補わない
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
]);
