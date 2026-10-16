# Udonarium Axe Backend — Claude Code向け開発指示

Udonarium Axe（ブラウザで遊ぶTRPGのオンラインセッション支援ツール）を動かすサーバーをまとめたリポジトリ。
SkyWay版の配信で使うトークン発行と、SkyWayを使わずに遊ぶための部屋のサーバー（サーバー版）を置く。
フロントエンドは別リポジトリ（`udonarium_axe`）で、同じ規範で開発している。

本ファイルは**日々の開発で守るべき最小限の規範**のみを記す。詳細は以下を参照。

- リポジトリの構成・アプリごとのコマンドと決まり・コミットとフック → [docs/development/index.md](docs/development/index.md)
- テスト・CI・リリース → [docs/development/ci.md](docs/development/ci.md)
- ドキュメントの書きかた → [docs/development/docs.md](docs/development/docs.md)
- 部屋のサーバーとAxeのやりとり → [docs/cloudflare/protocol.md](docs/cloudflare/protocol.md)

## 構成の規範

| アプリ            | 一行サマリ                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- |
| `apps/php`        | PHP版。SkyWayのトークン発行（レンタルサーバー、composer）                          |
| `apps/vercel`     | Vercel版。トークン発行と部屋のサーバー（Functions・Redis・Blob、独立したlockfile） |
| `apps/cloudflare` | Cloudflare版。部屋のサーバー（Workers・Durable Objects・R2、独立したlockfile）     |

- 3つのアプリは互いを`import`しない。Deployボタンはそのディレクトリだけを複製する
- 部屋のサーバーの共有コード（`src/core/`・`contracts/`・`test/shared/`）は`apps/cloudflare`の方を直し、
  `node scripts/sync-shared.mjs`で`apps/vercel`へ写す（写しが同じかをCIが`--check`で確かめる）
- `apps/cloudflare/contracts/`はサーバー側が持ち主。Axeはこれを写して使い、両側のテストが同じJSONを読む。
  やりとりの形を変えたら`PROTOCOL_VERSION`を上げ、Axe側に知らせる

## 規範ハイライト

- **カバレッジ100%**: Vercel版とCloudflare版は、行・分岐・関数・文のすべてで100%を求める。下回ると`npm test`が落ちる
- **相対`import`は拡張子まで書く**（`./foo.js`）。JSONの`import`には`with { type: 'json' }`を付ける。
  Vercel版はNodeがバンドルせずに読むので、抜けると本番で`ERR_MODULE_NOT_FOUND`になる
- **`wrangler`は固定**: `@cloudflare/vitest-pool-workers`が使う版に合わせる（CIがworkerdが1つかを確かめる）
- **PHP版**: PHP 8.3で動く書きかた、`declare(strict_types=1);`、`@PER-CS`、PHPStanレベル9、PHPUnit 12と13の両対応
- **秘密の値**は、例でも本物を書かない

## 技術スタック

- **Cloudflare版** — Workers・Durable Objects・R2、Hono、valibot。テストは`@cloudflare/vitest-pool-workers`（workerdの中）
- **Vercel版** — Vercel Functions（Node）・Redis・Vercel Blob。テストは本物のRedisを使う（`docker compose up -d redis`）
- **部屋のサーバーの共通** — `@msgpack/msgpack`、`bcdice`（サーバーで振るダイス）
- **PHP版** — PHP 8.3〜8.5、PHPUnit、PHPStan、PHP-CS-Fixer（Dockerで動かす）
- **文書とリリース** — VitePress（`docs/`）、semantic-release

## 開発コマンド

| 場所              | コマンド                                                       | 用途                                            |
| ----------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `apps/cloudflare` | `npm run dev`                                                  | 手元の部屋のサーバー（`http://localhost:8787`） |
| `apps/cloudflare` | `npm run lint` / `npm run typecheck` / `npm test`              | lint・型検査・テスト（カバレッジ100%）          |
| `apps/vercel`     | `npm run lint` / `npm run typecheck` / `npm test`              | lint・型検査・テスト（Redisが要る）             |
| `apps/vercel`     | `npm run check:esm`                                            | tscで出したものを素のNodeで読む                 |
| 両アプリ          | `npm run format` / `npm run format:check`                      | Prettierで整形／整形の確認                      |
| `apps/php`        | `bin/phpunit` / `bin/phpstan analyse` / `bin/php-cs-fixer fix` | テスト・静的解析・整形（Docker）                |
| ルート            | `node scripts/sync-shared.mjs`                                 | 共有コードを`apps/vercel`へ写す                 |
| ルート            | `npm run docs:dev` / `npm run docs:build`                      | 文書（VitePress）                               |

## コミット・フック規約（要点）

詳細は[docs/development/index.md](docs/development/index.md#コミットとpull-request)を参照。以下は要点のみ。

- **コミットメッセージは必ず英語**（件名も本文も）。形式は`type(scope): subject`（Conventional Commits）
  - scopeは`php`・`vercel`・`cloudflare`・`ci`・`docs`など。例: `fix(cloudflare): keep a seat's role across a reconnect`
- 複数の論理的変更を1コミットに混ぜない（整形だけ、依存の更新だけのコミットは分ける）
- **lefthook迂回は絶対禁止**（`--no-verify` / `LEFTHOOK=0` / `core.hooksPath`変更等）。
  フックが落ちたら原因を直してから再コミットする
  - `commit-msg`: `commitlint` / `pre-commit`: stagedのTypeScriptに`eslint`、PHPに`php-cs-fixer`と`phpstan` /
    `pre-push`: 両アプリの型検査とテスト（Vercel版は`check:esm`も）
- mainへのPRでは[.github/workflows/ci.yml](.github/workflows/ci.yml)が、全アプリのlint・整形・型検査・テストを回す
- `CHANGELOG.md`は手で直さない。semantic-releaseがConventional Commitsから生成する

## コメント・テスト名は英語

`apps/`配下のコードのコメントと、`describe()` / `it()`のテスト名は英語で書く。
`docs/`とREADMEの本文は対象外（詳細は[docs/development/index.md](docs/development/index.md#コメントとテスト名)）。

## ドキュメントの日本語

README・`docs/`のまとまった日本語は`yomiyasu`スキルを通して書く
（[.claude/settings.json](.claude/settings.json)の`enabledPlugins`で有効化済み。ほかの日本語校正スキルとは併用しない）。
詳細は[docs/development/docs.md](docs/development/docs.md)にあり、ここには要点だけを書く。

- 対象は新規執筆と書き直し。1〜2行の追記や表のセル修正はそのまま書いてよい
- 和文と英数字の間に半角空白を入れない。空けてある既存の文書は書き直すときにそろえる
- Markdownには**Prettierをかけない**（表は手でそろえる）。各アプリの`.prettierignore`も`*.md`を外している
- **コミットメッセージとCHANGELOGは対象外**。前者は英語で書き、後者はsemantic-releaseが生成する

## 留意事項

- 版はリポジトリ全体で1つ。`main`に入るとsemantic-releaseが決め、PHP版のzipを添付したリリースを作る
- Prettierの設定はフロントと同じ（シングルクォート、`printWidth: 120`、`trailingComma: 'es5'`）
