/* global console, process */
// Checks that every link to a heading in the docs leads to a heading that exists. The VitePress
// build checks only that a linked page exists, so a renamed heading would otherwise leave its links
// landing at the top of the page without a word.
//
// docs/ is the site, whose heading ids come from the site's own slugify. development/ is read on
// GitHub, which makes heading ids by its own rule. Links between the two are written as full URLs,
// and are checked too.
//
//   node scripts/check-doc-anchors.mjs   exits with 1 and lists the broken links if there are any
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify } from '../docs/.vitepress/slugify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const DEVELOPMENT = join(ROOT, 'development');
const SITE = 'https://xelltis.github.io/udonarium_axe_backend';
const GITHUB = 'https://github.com/Xelltis/udonarium_axe_backend/blob/main/development/';

/** The Markdown files under dir, leaving out the site's own folder and installed packages. */
const markdownUnder = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (name === '.vitepress' || name === 'node_modules') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownUnder(path);
    return name.endsWith('.md') ? [path] : [];
  });

/** The id GitHub gives a heading: lower case, only letters, marks, numbers, `_`, `-`, and spaces made `-`. */
const githubSlug = (text) =>
  text
    .replace(/[`*]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');

/** The ids of a page's headings. A repeated heading gets -1, -2 and so on, as both sites give it. */
const anchorsOf = (text, slug) => {
  const ids = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (!heading) continue;
    const plain = heading[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const id = slug(plain);
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    ids.add(count ? `${id}-${count}` : id);
  }
  return ids;
};

/** The site path a docs/ file is served at, as links write it (`guide/index.md` is `/guide/`). */
const pageOf = (file) =>
  '/' +
  relative(DOCS, file)
    .replace(/index\.md$/, '')
    .replace(/\.md$/, '');

const siteFiles = markdownUnder(DOCS);
const siteAnchors = new Map(siteFiles.map((file) => [pageOf(file), anchorsOf(readFileSync(file, 'utf-8'), slugify)]));
const devFiles = existsSync(DEVELOPMENT) ? markdownUnder(DEVELOPMENT) : [];
const devAnchors = new Map(
  devFiles.map((file) => [relative(DEVELOPMENT, file), anchorsOf(readFileSync(file, 'utf-8'), githubSlug)])
);

const broken = [];
/** Records a link that leads to no page, or to no heading on its page. */
const check = (from, link, ids, hash, what) => {
  if (!ids) broken.push(`${from}: no page ${what} (${link})`);
  else if (hash !== undefined && !ids.has(decodeURIComponent(hash))) broken.push(`${from}: no heading #${hash} on ${what}`);
};
const sitePage = (path) => siteAnchors.get(path) ?? siteAnchors.get(`${path}/`);

for (const file of siteFiles) {
  const from = relative(ROOT, file);
  for (const [, link] of readFileSync(file, 'utf-8').matchAll(/\]\((\/[^)\s]*|#[^)\s]*|https:\/\/github\.com\/[^)\s]*)\)/g)) {
    if (link.startsWith(GITHUB)) {
      const [name, hash] = link.slice(GITHUB.length).split('#');
      check(from, link, devAnchors.get(name), hash, `development/${name}`);
    } else if (!link.startsWith('https://')) {
      const [path, hash] = link.split('#');
      if (hash !== undefined) check(from, link, sitePage(path || pageOf(file)), hash, path || pageOf(file));
    }
  }
}

for (const file of devFiles) {
  const from = relative(ROOT, file);
  const own = relative(DEVELOPMENT, file);
  for (const [, link] of readFileSync(file, 'utf-8').matchAll(/\]\(([^)\s]+)\)/g)) {
    if (link.startsWith(SITE)) {
      const [path, hash] = link.slice(SITE.length).split('#');
      check(from, link, sitePage(path || '/'), hash, path || '/');
    } else if (link.startsWith('#')) {
      check(from, link, devAnchors.get(own), link.slice(1), own);
    } else if (link.startsWith('./') && /\.md(#|$)/.test(link)) {
      const [name, hash] = link.slice(2).split('#');
      check(from, link, devAnchors.get(name), hash, `development/${name}`);
    }
  }
}

if (broken.length) {
  console.error(broken.join('\n'));
  console.error(`${broken.length} link(s) lead to no page or heading.`);
  process.exit(1);
}
console.log('Every link to a heading leads to one.');
