import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vitepress';

import { slugify } from './slugify.mjs';

const repo = 'https://github.com/Xelltis/udonarium_axe_backend';
const base = '/udonarium_axe_backend/';

// Social crawlers ignore relative URLs, so the deployed origin has to be
// spelled out here. Change it together with the Pages settings.
const siteUrl = `https://xelltis.github.io${base}`;
const siteName = 'Udonarium Axe Backend';
const siteDescription = 'Udonarium Axeのバックエンドを設置・運用するためのドキュメント';

/** The Axe user guide, which covers playing and hosting the app itself. */
const axeGuide = 'https://xelltis.github.io/udonarium_axe/';

/**
 * The first real paragraph of a page, so a shared link describes that page
 * instead of repeating the site description. Headings, containers, tables,
 * lists and component tags are skipped.
 */
function leadParagraph(file: string): string {
  let source: string;
  try {
    source = readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const paragraphs: string[] = [];
  let current: string[] = [];
  const length = () => paragraphs.join('').length;
  const flush = () => {
    if (current.length) paragraphs.push(current.join(''));
    current = [];
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      if (length() >= 60) break;
      continue;
    }
    if (/^[#>|:`-]|^<|^\d+\./.test(line)) {
      flush();
      if (paragraphs.length) break;
      continue;
    }
    current.push(line);
  }
  flush();

  const text = paragraphs
    .join(' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

export default defineConfig({
  lang: 'ja-JP',
  title: siteName,
  description: siteDescription,
  base,
  cleanUrls: true,
  lastUpdated: true,
  transformPageData(pageData, { siteConfig }) {
    const isHome = pageData.relativePath === 'index.md';
    const title = isHome ? siteName : `${pageData.title} | ${siteName}`;
    const description =
      pageData.description ||
      (isHome ? siteDescription : leadParagraph(join(siteConfig.srcDir, pageData.filePath))) ||
      siteDescription;
    const url = siteUrl + pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '');

    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: siteName }],
      ['meta', { property: 'og:locale', content: 'ja_JP' }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['link', { rel: 'canonical', href: url }],
    );
  },
  head: [
    ['meta', { name: 'theme-color', content: '#8b7cf6' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap',
      },
    ],
  ],
  markdown: {
    // The same slugify scripts/check-doc-anchors.mjs checks links against (see slugify.mjs).
    anchor: { slugify },
    config: (md) => {
      // A heading that starts with a step number ("1. …") is drawn as a numbered step. The number
      // stays in the heading's text, so its id and the outline keep it; only the dot is hidden.
      // This runs after the anchor plugin, so the ids are made from the heading as written.
      md.core.ruler.push('axe-step-headings', (state) => {
        const tokens = state.tokens;
        for (let i = 0; i < tokens.length - 1; i += 1) {
          const open = tokens[i];
          if (open.type !== 'heading_open' || (open.tag !== 'h2' && open.tag !== 'h3')) continue;
          const first = tokens[i + 1].children?.[0];
          const step = first?.type === 'text' ? first.content.match(/^(\d+)\.\s+/) : null;
          if (!first || !step) continue;
          open.attrJoin('class', 'axe-step');
          const badge = new state.Token('html_inline', '', 0);
          badge.content = `<span class="axe-step-number">${step[1]}<span class="axe-step-dot">.</span></span> `;
          first.content = first.content.slice(step[0].length);
          tokens[i + 1].children?.unshift(badge);
        }
      });

      // Default VitePress tables are `display: block`, so they shrink to their
      // content and hug the left edge. Wrapping them lets the table fill the
      // column while wide ones scroll sideways inside the wrapper.
      md.renderer.rules.table_open = () => '<div class="table-wrap">\n<table>\n';
      md.renderer.rules.table_close = () => '</table>\n</div>\n';

      // Sources here are written one sentence per line. A soft line break
      // renders as a space, which Japanese does not want, not even before a
      // Latin word ("…です。Axeは"). Drop it when either side is Japanese.
      const cjk = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿！-｠]/;
      const edgeChar = (
        tokens: { type: string; content: string }[],
        from: number,
        step: number,
      ): string => {
        for (let i = from; i >= 0 && i < tokens.length; i += step) {
          const { type, content } = tokens[i];
          if (type === 'softbreak' || type === 'hardbreak') return '';
          if (!content) continue;
          return step > 0 ? content[0] : content[content.length - 1];
        }
        return '';
      };
      md.core.ruler.push('cjk-softbreak', (state) => {
        for (const token of state.tokens) {
          if (token.type !== 'inline' || !token.children) continue;
          const kids = token.children;
          for (let i = 1; i < kids.length - 1; i += 1) {
            if (kids[i].type !== 'softbreak') continue;
            if (cjk.test(edgeChar(kids, i - 1, -1)) || cjk.test(edgeChar(kids, i + 1, 1))) {
              kids[i].type = 'text';
              kids[i].content = '';
            }
          }
        }
      });
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'はじめに', link: '/guide/' },
      { text: 'SkyWay版を置く', link: '/skyway/' },
      { text: 'サーバー版を置く', link: '/server/' },
      { text: '運営する', link: '/operate/' },
      { text: 'リファレンス', link: '/reference/' },
      { text: 'Axeの利用ガイド', link: axeGuide },
    ],
    sidebar: [
      {
        text: 'はじめに',
        items: [
          { text: 'はじめに', link: '/guide/' },
          { text: 'どれを置くか', link: '/guide/choose' },
          { text: '設置の準備', link: '/guide/prepare' },
          { text: 'Axeの設定（config.json）', link: '/guide/client-config' },
          { text: 'よくある質問', link: '/guide/faq' },
        ],
      },
      {
        text: 'SkyWay版を置く',
        collapsed: false,
        items: [
          { text: 'SkyWay版のしくみ', link: '/skyway/' },
          { text: 'SkyWayのアプリを作る', link: '/skyway/app' },
          { text: 'Vercelに置く', link: '/skyway/vercel' },
          { text: 'レンタルサーバーに置く（PHP版）', link: '/skyway/php' },
          { text: '設定項目', link: '/skyway/configuration' },
          { text: '困ったとき', link: '/skyway/troubleshooting' },
        ],
      },
      {
        text: 'サーバー版を置く',
        collapsed: false,
        items: [
          { text: 'サーバー版のしくみ', link: '/server/' },
          { text: 'Discordのアプリを作る', link: '/server/discord' },
          { text: 'Cloudflareに置く', link: '/server/cloudflare' },
          { text: 'Vercelに置く', link: '/server/vercel' },
          { text: '設定項目', link: '/server/configuration' },
          { text: '困ったとき', link: '/server/troubleshooting' },
        ],
      },
      {
        text: '運営する',
        collapsed: true,
        items: [
          { text: '運用', link: '/operate/' },
          { text: '料金と上限', link: '/operate/costs' },
          { text: '安全のしくみ', link: '/operate/security' },
          { text: '運営の方針', link: '/operate/policies' },
          { text: 'プライバシーポリシーのひな形', link: '/operate/privacy-template' },
          { text: '利用規約のひな形', link: '/operate/terms-template' },
          { text: '自分のリポジトリから自動でデプロイする', link: '/operate/auto-deploy' },
        ],
      },
      {
        text: 'リファレンス',
        collapsed: true,
        items: [
          { text: 'リファレンスについて', link: '/reference/' },
          { text: 'トークン発行のAPI', link: '/reference/token-api' },
          { text: '部屋のサーバーのAPI', link: '/reference/server-api' },
        ],
      },
    ],
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '検索', buttonAriaLabel: '検索' },
          modal: {
            displayDetails: '本文も表示',
            resetButtonTitle: '入力を消す',
            backButtonTitle: '検索を閉じる',
            noResultsText: '見つかりませんでした',
            footer: {
              selectText: '開く',
              selectKeyAriaLabel: 'Enter',
              navigateText: '選ぶ',
              navigateUpKeyAriaLabel: '上へ',
              navigateDownKeyAriaLabel: '下へ',
              closeText: '閉じる',
              closeKeyAriaLabel: 'Esc',
            },
          },
        },
      },
    },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'このページを編集',
    },
    outline: { level: [2, 3], label: '目次' },
    docFooter: { prev: '前のページ', next: '次のページ' },
    lastUpdatedText: '最終更新',
    returnToTopLabel: 'トップへ戻る',
    darkModeSwitchLabel: 'テーマ',
    lightModeSwitchTitle: 'ライトモードにする',
    darkModeSwitchTitle: 'ダークモードにする',
    skipToContentLabel: '本文へ移動',
    sidebarMenuLabel: 'メニュー',
    notFound: {
      title: 'ページが見つかりません',
      quote: 'URLが変わったか、ページが移ったのかもしれません。トップから探してください。',
      linkLabel: 'トップへ',
      linkText: 'トップへ',
    },
    footer: {
      message: 'MITライセンスで公開しています',
      copyright: 'Udonarium Axe Backend',
    },
  },
});
