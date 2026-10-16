/* global console, process */
// Copies the code apps/cloudflare and apps/vercel both use (the room server's workings, the shape of the
// exchanges with Axe, the shared tests) from apps/cloudflare to apps/vercel. The Deploy button copies only
// the app's directory, so the shared code is kept inside each app. Change it in apps/cloudflare, then run this.
//
//   node scripts/sync-shared.mjs          copies (and deletes what only apps/vercel has)
//   node scripts/sync-shared.mjs --check  checks the copies are the same; exits with 1 if not (CI)
//
// The npm packages the shared code uses, and the Prettier that lays it out, are given the same version
// range in both package.json files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'apps/cloudflare');
const TARGET = join(ROOT, 'apps/vercel');
const SHARED = ['src/core', 'contracts', 'test/shared'];
const DEPENDENCIES = ['@msgpack/msgpack', 'bcdice', 'hono', 'valibot'];
// Prettier lays out both copies of the shared code, which have to come out byte for byte the same.
const DEV_DEPENDENCIES = ['prettier'];

const check = process.argv.includes('--check');

/** The files under dir, as paths relative to dir. None when dir does not exist. */
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

const packageOf = (app) => JSON.parse(readFileSync(join(app, 'package.json'), 'utf-8'));
const [source, target] = [packageOf(SOURCE), packageOf(TARGET)];
for (const [field, names] of [
  ['dependencies', DEPENDENCIES],
  ['devDependencies', DEV_DEPENDENCIES],
]) {
  for (const name of names) {
    const [inSource, inTarget] = [source[field]?.[name], target[field]?.[name]];
    if (inSource !== inTarget) {
      problems.push(`${name} is ${inSource} in apps/cloudflare but ${inTarget} in apps/vercel`);
    }
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
