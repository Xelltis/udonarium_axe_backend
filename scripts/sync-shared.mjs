/* global console, process */
// apps/cloudflare と apps/vercel が同じものを使うコード（部屋のサーバーの中身、やりとりの形、共有のテスト）を、
// apps/cloudflare から apps/vercel へ写す。Deploy ボタンはアプリのディレクトリだけを複製するので、
// 共有のコードもそれぞれのアプリの中に置く。直すのは apps/cloudflare の方で、直したらこれを流す。
//
//   node scripts/sync-shared.mjs          写す（apps/vercel にだけあるものは消す）
//   node scripts/sync-shared.mjs --check  写しが同じかを確かめる。違えば 1 で終わる（CI）
//
// 共有のコードが使う npm のパッケージは、両方の package.json で同じ版の指定にしておく。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'apps/cloudflare');
const TARGET = join(ROOT, 'apps/vercel');
const SHARED = ['src/core', 'contracts', 'test/shared'];
const DEPENDENCIES = ['@msgpack/msgpack', 'bcdice', 'hono', 'valibot'];

const check = process.argv.includes('--check');

/** dir の下のファイル（dir からの相対パス）。dir が無ければ空 */
const filesUnder = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? filesUnder(path).map((file) => join(name, file))
      : [name];
  });
};

const problems = [];

for (const dir of SHARED) {
  const from = join(SOURCE, dir);
  const to = join(TARGET, dir);
  const sources = new Set(filesUnder(from));
  for (const file of sources) {
    const source = join(from, file);
    const target = join(to, file);
    const same = existsSync(target) && readFileSync(source).equals(readFileSync(target));
    if (same) continue;
    if (check) {
      problems.push(`${relative(ROOT, target)} differs from ${relative(ROOT, source)}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
  for (const file of filesUnder(to)) {
    if (sources.has(file)) continue;
    if (check) problems.push(`${relative(ROOT, join(to, file))} is not in apps/cloudflare`);
    else rmSync(join(to, file));
  }
}

const dependenciesOf = (app) =>
  JSON.parse(readFileSync(join(app, 'package.json'), 'utf-8')).dependencies ?? {};
const sourceDependencies = dependenciesOf(SOURCE);
const targetDependencies = dependenciesOf(TARGET);
for (const name of DEPENDENCIES) {
  if (sourceDependencies[name] !== targetDependencies[name]) {
    problems.push(
      `${name} is ${sourceDependencies[name]} in apps/cloudflare but ${targetDependencies[name]} in apps/vercel`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(
    check
      ? 'Edit the shared code in apps/cloudflare, then run `node scripts/sync-shared.mjs`.'
      : 'Give both apps the same versions of the packages above.',
  );
  process.exit(1);
}
console.log(check ? 'The shared code is in step.' : 'Copied the shared code to apps/vercel.');
