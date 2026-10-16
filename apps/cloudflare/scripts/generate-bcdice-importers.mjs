/* global console */
// BCDice のゲームシステムと翻訳を、名前から読み込むための import 表を作る。
// bcdice 同梱の DynamicLoader は実行時に組み立てたパスを require に渡すため、バンドラが追えない。
// そこでパスを前もって書き出しておく。Worker はすべてを1つのバンドルに入れるが、
// 動的 import にしておけば、評価されるのは振るときに初めて使うシステムだけになり、起動は遅くならない。
// パスは拡張子まで書き、JSON には属性を付ける。Vercel 版では Node がバンドルせずにそのまま読むため。
//
// bcdice を上げたら `npm run generate:bcdice` で作り直す。
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
  '// scripts/generate-bcdice-importers.mjs が作る。手で直さない',
  '',
  '/** ゲームシステムのクラス名から、そのシステムを読み込む */',
  'export const GAME_SYSTEM_IMPORTERS: Readonly<Record<string, () => Promise<unknown>>> = {',
  ...classNames.map((name) => `  '${name}': () => import('bcdice/lib/bcdice/game_system/${name}.js'),`),
  '};',
  '',
  '/** 「元のクラス名.ロケール」から、その翻訳を読み込む */',
  'export const I18N_IMPORTERS: Readonly<Record<string, () => Promise<unknown>>> = {',
  ...translations.map(
    (key) => `  '${key}': () => import('bcdice/lib/bcdice/i18n/${key}.json', { with: { type: 'json' } }),`
  ),
  '};',
  '',
];
writeFileSync(OUTPUT, lines.join('\n'));
console.log(`${classNames.length} game systems, ${translations.length} translations -> ${OUTPUT}`);
