import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vitepress';

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
  head: [['meta', { name: 'theme-color', content: '#8b7cf6' }]],
  markdown: {
    // A copy of VitePress's own slugify with the result put back into NFC.
    // Its NFKD pass strips only the combining marks in U+0300..U+036F, which
    // leaves a Japanese dakuten decomposed: the id holds ハ + U+3099 where a
    // hand-written link holds バ. The two look the same and never match.
    anchor: {
      slugify: (str: string) =>
        str
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .replace(/[\u0000-\u001f]/g, '')
          .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
          .replace(/-{2,}/g, '-')
          .replace(/^-+|-+$/g, '')
          .replace(/^(\d)/, '_$1')
          .toLowerCase()
          .normalize('NFC'),
    },
    config: (md) => {
      // Default VitePress tables are `display: block`, so they shrink to their
      // content and hug the left edge. Wrapping them lets the table fill the
      // column while wide ones scroll sideways inside the wrapper.
      md.renderer.rules.table_open = () => '<div class="table-wrap">\n<table>\n';
      md.renderer.rules.table_close = () => '</table>\n</div>\n';

      // Sources here are written one sentence per line. A soft line break
      // renders as a space, which Japanese does not want mid-sentence.
      // Drop it when both sides are Japanese.
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
            if (cjk.test(edgeChar(kids, i - 1, -1)) && cjk.test(edgeChar(kids, i + 1, 1))) {
              kids[i].type = 'text';
              kids[i].content = '';
            }
          }
        }
      });
    },
  },
  themeConfig: {
    nav: [
      { text: 'はじめに', link: '/guide/' },
      {
        text: 'トークン発行',
        items: [
          { text: 'しくみとAPI', link: '/token/' },
          { text: 'PHP版', link: '/php/' },
          { text: 'Vercel版', link: '/vercel/' },
        ],
      },
      { text: 'Cloudflare版', link: '/cloudflare/' },
      { text: '今後の計画', link: '/guide/roadmap' },
      { text: '開発', link: '/development/' },
      { text: 'Axeの利用ガイド', link: axeGuide },
    ],
    sidebar: [
      {
        text: 'ガイド',
        items: [
          { text: 'はじめに', link: '/guide/' },
          { text: 'どれを使うか', link: '/guide/choose' },
          { text: '設置の準備', link: '/guide/prepare' },
          { text: 'SkyWayのアプリを作る', link: '/guide/skyway' },
          { text: 'Discordのアプリを作る', link: '/guide/discord' },
          { text: 'クイックスタート', link: '/guide/quickstart' },
          { text: 'Axe側の設定', link: '/guide/client-config' },
          { text: 'よくある質問', link: '/guide/faq' },
          { text: '今後の計画（サーバー版）', link: '/guide/roadmap' },
        ],
      },
      {
        text: 'SkyWayのトークン発行',
        items: [
          { text: 'トークン発行のしくみ', link: '/token/' },
          { text: 'APIリファレンス', link: '/token/api' },
        ],
      },
      {
        text: 'PHP版',
        collapsed: false,
        items: [
          { text: '概要', link: '/php/' },
          { text: '設置する', link: '/php/setup' },
          { text: '設定項目', link: '/php/configuration' },
          { text: '困ったとき', link: '/php/troubleshooting' },
        ],
      },
      {
        text: 'Vercel版',
        collapsed: false,
        items: [
          { text: '概要', link: '/vercel/' },
          { text: 'デプロイする（トークン発行）', link: '/vercel/deploy' },
          { text: '部屋のサーバーとして置く', link: '/vercel/rooms' },
          { text: '設定項目', link: '/vercel/configuration' },
          { text: '困ったとき', link: '/vercel/troubleshooting' },
        ],
      },
      {
        text: 'Cloudflare版（サーバー版）',
        collapsed: false,
        items: [
          { text: '概要', link: '/cloudflare/' },
          { text: 'デプロイする', link: '/cloudflare/deploy' },
          { text: '設定項目', link: '/cloudflare/configuration' },
          { text: '部屋のサーバー', link: '/cloudflare/rooms' },
          { text: 'ログインと役割', link: '/cloudflare/login' },
          { text: '部屋のプロトコル', link: '/cloudflare/protocol' },
          { text: 'APIリファレンス', link: '/cloudflare/api' },
          { text: '安全のしくみ', link: '/cloudflare/security' },
          { text: '運用と料金', link: '/cloudflare/operations' },
          { text: 'mainからの自動デプロイ', link: '/cloudflare/auto-deploy' },
          { text: '運営する人へ', link: '/cloudflare/policies' },
          { text: 'プライバシーポリシーのひな形', link: '/cloudflare/privacy-template' },
          { text: '利用規約のひな形', link: '/cloudflare/terms-template' },
          { text: '困ったとき', link: '/cloudflare/troubleshooting' },
        ],
      },
      {
        text: '開発',
        items: [
          { text: '開発に参加する', link: '/development/' },
          { text: 'テスト・CI・リリース', link: '/development/ci' },
          { text: 'ドキュメントを書く', link: '/development/docs' },
        ],
      },
    ],
    search: { provider: 'local' },
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
    sidebarMenuLabel: 'メニュー',
    footer: {
      message: 'MITライセンスで公開しています',
      copyright: 'Udonarium Axe Backend',
    },
  },
});
