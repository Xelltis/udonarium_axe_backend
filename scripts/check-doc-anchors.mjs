/* global console, process */
// Checks that every link in docs/ to a heading (/page#anchor or #anchor) leads to a heading that
// exists. The VitePress build checks only that a linked page exists, so a renamed heading would
// otherwise leave its links landing at the top of the page without a word.
//
//   node scripts/check-doc-anchors.mjs   exits with 1 and lists the broken links if there are any
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify } from '../docs/.vitepress/slugify.mjs';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

/** The Markdown files under dir, leaving out the site's own folder and installed packages. */
const markdownUnder = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (name === '.vitepress' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownUnder(path);
    return name.endsWith('.md') ? [path] : [];
  });

/** The site path a file is served at, as links write it (`guide/index.md` is `/guide/`). */
const pageOf = (file) =>
  '/' +
  relative(DOCS, file)
    .replace(/index\.md$/, '')
    .replace(/\.md$/, '');

/** The ids of a page's headings. A repeated heading gets -1, -2 and so on, as VitePress gives it. */
const anchorsOf = (text) => {
  const ids = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (!heading) continue;
    const plain = heading[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const id = slugify(plain);
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    ids.add(count ? `${id}-${count}` : id);
  }
  return ids;
};

const files = markdownUnder(DOCS);
const anchors = new Map(files.map((file) => [pageOf(file), anchorsOf(readFileSync(file, 'utf-8'))]));
const broken = [];
for (const file of files) {
  for (const [, link] of readFileSync(file, 'utf-8').matchAll(/\]\((\/[^)\s]*|#[^)\s]*)\)/g)) {
    const [path, hash] = link.split('#');
    if (hash === undefined) continue;
    const page = path || pageOf(file);
    const ids = anchors.get(page) ?? anchors.get(`${page}/`);
    if (!ids) broken.push(`${relative(DOCS, file)}: no page ${page} (${link})`);
    else if (!ids.has(decodeURIComponent(hash))) broken.push(`${relative(DOCS, file)}: no heading #${hash} on ${page}`);
  }
}

if (broken.length) {
  console.error(broken.join('\n'));
  console.error(`${broken.length} link(s) lead to no heading.`);
  process.exit(1);
}
console.log('Every link to a heading leads to one.');
