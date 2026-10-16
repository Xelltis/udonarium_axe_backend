/* global console */
// Writes the table of imports that load BCDice's game systems and translations by name.
// The DynamicLoader that comes with bcdice hands require a path put together at run time, which a
// bundler cannot follow, so the paths are written out beforehand. The Worker puts everything in one
// bundle, but as dynamic imports, only the systems a roll first uses are evaluated, and starting up
// is no slower. The paths carry their extensions and the JSON imports their attribute, because the
// Vercel version has Node read them as they are, without a bundle.
//
// After upgrading bcdice, write it again with `npm run generate:bcdice`.
import { readFileSync, writeFileSync } from 'node:fs';

const LIB = 'node_modules/bcdice/lib/bcdice';
const OUTPUT = 'src/core/dice/bcdice-importers.generated.ts';

const { gameSystems } = JSON.parse(readFileSync(`${LIB}/game_system_list.json`, 'utf-8'));
const { i18nList } = JSON.parse(readFileSync(`${LIB}/i18n_list.json`, 'utf-8'));

const classNames = [...new Set(gameSystems.map(({ className }) => className))].sort();
const translations = i18nList
  .flatMap(({ baseClassName, locales }) => locales.map((locale) => `${baseClassName}.${locale}`))
  .sort();

const lines = [
  '// Written by scripts/generate-bcdice-importers.mjs. Do not edit it by hand.',
  '',
  '/** Loads a game system by its class name. */',
  'export const GAME_SYSTEM_IMPORTERS: Readonly<Record<string, () => Promise<unknown>>> = {',
  ...classNames.map((name) => `  '${name}': () => import('bcdice/lib/bcdice/game_system/${name}.js'),`),
  '};',
  '',
  '/** Loads a translation by its `base class name.locale`. */',
  'export const I18N_IMPORTERS: Readonly<Record<string, () => Promise<unknown>>> = {',
  ...translations.map(
    (key) => `  '${key}': () => import('bcdice/lib/bcdice/i18n/${key}.json', { with: { type: 'json' } }),`
  ),
  '};',
  '',
];
writeFileSync(OUTPUT, lines.join('\n'));
console.log(`${classNames.length} game systems, ${translations.length} translations -> ${OUTPUT}`);
