/* global console, process */
// Copies the code apps/cloudflare and apps/vercel both use (the room server's workings, the shape of the
// exchanges with Axe, the shared tests) from apps/cloudflare to apps/vercel. The Deploy button copies only
// the app's directory, so the shared code is kept inside each app. Change it in apps/cloudflare, then run this.
//
//   node scripts/sync-shared.mjs          copies (and deletes what only apps/vercel has)
//   node scripts/sync-shared.mjs --check  checks the copies are the same; exits with 1 if not (CI)
//   node scripts/sync-shared.mjs --staged checks what is staged for the commit instead (pre-commit)
//
// The npm packages the shared code uses, and the Prettier that lays it out, are given the same version
// range in both package.json files.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'apps/cloudflare');
const TARGET = join(ROOT, 'apps/vercel');
const SHARED = ['src/core', 'contracts', 'test/shared'];
const DEPENDENCIES = ['@msgpack/msgpack', 'bcdice', 'hono', 'valibot'];
// Prettier lays out both copies of the shared code, which have to come out byte for byte the same.
const DEV_DEPENDENCIES = ['prettier'];

const staged = process.argv.includes('--staged');
const check = staged || process.argv.includes('--check');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
/** A path as git names it: relative to the repository, with forward slashes on every platform. */
const gitPath = (path) => relative(ROOT, path).split(sep).join('/');

/** The files under dir, as paths relative to dir: those staged, or those on disk. None when there is no dir. */
const filesUnder = (dir) => {
  if (staged) {
    const prefix = `${gitPath(dir)}/`;
    return git('ls-files', '--cached', '-z', '--', prefix)
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((path) => path.slice(prefix.length));
  }
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? filesUnder(path).map((file) => join(name, file))
      : [name];
  });
};

/** A file's bytes, as staged or on disk; null when there is none. */
const read = (path) => {
  if (!staged) return existsSync(path) ? readFileSync(path) : null;
  try {
    return git('show', `:${gitPath(path)}`);
  } catch {
    return null;
  }
};

const problems = [];
let copied = 0;
let removed = 0;

for (const dir of SHARED) {
  const from = join(SOURCE, dir);
  const to = join(TARGET, dir);
  const sources = new Set(filesUnder(from));
  for (const file of sources) {
    const source = join(from, file);
    const target = join(to, file);
    const copy = read(target);
    const same = copy !== null && read(source).equals(copy);
    if (same) continue;
    if (check) {
      problems.push(`${relative(ROOT, target)} differs from ${relative(ROOT, source)}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied++;
    }
  }
  for (const file of filesUnder(to)) {
    if (sources.has(file)) continue;
    if (check) {
      problems.push(`${relative(ROOT, join(to, file))} is not in apps/cloudflare`);
    } else {
      rmSync(join(to, file));
      removed++;
    }
  }
}

const packageOf = (app) => JSON.parse(read(join(app, 'package.json')).toString('utf-8'));
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
  if (!check) console.error('Give both apps the same versions of the packages above.');
  else if (staged) {
    console.error(
      'Edit the shared code in apps/cloudflare, run `node scripts/sync-shared.mjs`, ' +
        'then stage both apps (`git add apps/cloudflare apps/vercel`).',
    );
  } else console.error('Edit the shared code in apps/cloudflare, then run `node scripts/sync-shared.mjs`.');
  process.exit(1);
}
if (check) console.log('The shared code is in step.');
else if (copied + removed === 0) console.log('The copies in apps/vercel were already in step.');
else console.log(`Copied ${copied} and removed ${removed} files of the shared code in apps/vercel.`);
