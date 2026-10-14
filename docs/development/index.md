# 開発に参加する

このリポジトリの開発に参加する人向けのページです。
バグの報告や機能の提案は、[Issues](https://github.com/Xelltis/udonarium_axe_backend/issues)からどうぞ。

## リポジトリの構成

```text
udonarium_axe_backend/
 ├─ apps/
 │   ├─ php/         PHP版（composer）
 │   ├─ vercel/      Vercel版（npm、独立したlockfile）
 │   └─ cloudflare/  Cloudflare版（npm、独立したlockfile）
 ├─ docs/            このドキュメント（VitePress）
 ├─ .github/         CI、Dependabot、Issue・PRのテンプレート
 ├─ package.json     ルートの道具（commitlint、lefthook、semantic-release、VitePress）
 └─ CHANGELOG.md     リリースごとの変更の記録（自動で更新される）
```

3つのアプリは、それぞれが単独で動くように作ってあります。
`apps/vercel`と`apps/cloudflare`は自分のlockfileを持つ独立したnpmのプロジェクトで、Deployボタンはそのディレクトリだけを複製します。
ほかのアプリのファイルを読み込む（`import`する）ことはしないでください。

Cloudflare版の部屋のサーバーとAxeのあいだのやりとりは、`apps/cloudflare/contracts/`に型とフィクスチャ（JSONの例）を置いています。
このディレクトリはサーバー側が持ち主で、Axeは同じ内容を写して使い、両側のテストが同じJSONを読みます。
Deployボタンが`apps/cloudflare`だけを複製するので、リポジトリの直下ではなく、その中に置いています。
やりとりの形を変えたら、`PROTOCOL_VERSION`を上げ、Axe側にも知らせてください（→ [部屋のプロトコル](/cloudflare/protocol)）。

Vercel版とCloudflare版では、Originの照合を同じ形で書いています（`apps/vercel/src/infra/url/origin.ts`と`apps/cloudflare/src/http/origin.ts`）。
この2つはCIで中身が同じかを確かめているので、片方を直したら、もう片方も同じように直してください。

## 準備

```sh
git clone https://github.com/Xelltis/udonarium_axe_backend.git
cd udonarium_axe_backend

# ルートの道具（commitlintなど）を入れる
npm install

# Gitのフック（lefthook）を入れる
npx lefthook install
```

lefthookは、コミットのときに次のことを確かめます。

- コミットメッセージが[Conventional Commits](https://www.conventionalcommits.org/ja/)の形になっているか（commitlint）
- PHPのファイルを変えたときは、PHP-CS-FixerとPHPStan（Dockerで動かす）

## アプリごとのコマンド

### PHP版（`apps/php`）

Dockerで開発環境を立ち上げます。

```sh
cd apps/php
docker compose up -d     # http://localhost:3000

bin/phpunit              # テスト
bin/phpstan analyse      # 静的解析（PHPStanのレベル9）
bin/php-cs-fixer fix     # 整形
bin/php-cs-fixer check   # 整形の確認（CIと同じ）
```

守ってほしいこと：

- PHP 8.3で動く書きかたにする（8.4以降でしか使えない機能は使わない）
- テストはPHPUnit 12と13の両方で動くようにする（CIはPHP 8.3でPHPUnit 12、8.4以降で13を使う）
- すべてのPHPファイルに`declare(strict_types=1);`を書く
- 整形は`@PER-CS`に従う

### Vercel版（`apps/vercel`）

```sh
cd apps/vercel
npm ci
npm run lint
npm run typecheck
npm test                 # カバレッジ100%を要求
```

相対パスの`import`には、拡張子（`./foo.js`）を付けてください。
Vercelは型を検査せずにファイルごとに変換するので、拡張子が無いと本番で`ERR_MODULE_NOT_FOUND`になります。
`npm run typecheck`がこれを見つけます。

### Cloudflare版（`apps/cloudflare`）

```sh
cd apps/cloudflare
npm ci
npm run dev              # http://localhost:8787
npm run lint
npm run typecheck
npm test                 # Workersのランタイム（workerd）の中で。カバレッジ100%を要求
```

テストは`@cloudflare/vitest-pool-workers`が持つwranglerとworkerdで動きます。
`npm run dev`と`npm run deploy`も同じランタイムで動くよう、`wrangler`はその版に固定しています。
上げるときは、`@cloudflare/vitest-pool-workers`が使う版に合わせてください（CIで確かめます）。

## コミットとPull Request

- コミットメッセージは[Conventional Commits](https://www.conventionalcommits.org/ja/)の形で書きます。スコープには`php`、`vercel`、`cloudflare`、`ci`、`docs`などを使います（例：`fix(cloudflare): …`）。
- 1つのPull Requestには、1つの変更だけを入れます。
- テストを足し、CIがすべて通ることを確かめます。
- `CHANGELOG.md`は手で直しません。リリースのときに自動で更新されます。

詳しくは[テスト・CI・リリース](/development/ci)を見てください。

## セキュリティ

脆弱性を見つけたときは、公開のIssueには書かず、[GitHub Security Advisory](https://github.com/Xelltis/udonarium_axe_backend/security/advisories/new)から非公開で知らせてください。
