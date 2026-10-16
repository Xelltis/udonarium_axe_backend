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

Vercel版とCloudflare版は、部屋のサーバーの中身を同じコードで動かします。
共有するのは`src/core/`（部屋の中継と同期、見え方、ダイス、トークン、HTTPの経路など）、`contracts/`、`test/shared/`（どちらの上でも流すテスト）の3つです。
正本は`apps/cloudflare`にあり、`apps/vercel`には写しを置きます。
共有のコードを直すときは`apps/cloudflare`の方を直し、次のコマンドで写してください。

```sh
node scripts/sync-shared.mjs
```

CIは、写しが正本と同じかと、共有のコードが使うパッケージ（hono・valibot・@msgpack/msgpack・bcdice）の版が両方のアプリでそろっているかを確かめます。
共有のコードは、Vercel版ではNodeがバンドルせずにそのまま読むので、相対`import`は`.js`まで書き、JSONの`import`には`with { type: 'json' }`を付けます。
抜けたときに見つけるものは、それぞれ違います。

| 抜けたもの                              | 見つけるもの                                       |
| --------------------------------------- | -------------------------------------------------- |
| 共有のコードの相対`import`の拡張子      | Cloudflare版の`npm run lint`                       |
| JSONの`import`の`with { type: 'json' }` | Vercel版の`npm run typecheck`と`npm run check:esm` |

Cloudflare版の部屋のサーバーとAxeのあいだのやりとりは、`apps/cloudflare/contracts/`に型とフィクスチャ（JSONの例）を置いています。
このディレクトリはサーバー側が持ち主で、Axeは同じ内容を写して使い、両側のテストが同じJSONを読みます。
Deployボタンが`apps/cloudflare`だけを複製するので、リポジトリの直下ではなく、その中に置いています。
やりとりの形を変えたら、`PROTOCOL_VERSION`を上げ、Axe側にも知らせてください（→ [部屋のプロトコル](/cloudflare/protocol)）。

## 準備

```sh
git clone https://github.com/Xelltis/udonarium_axe_backend.git
cd udonarium_axe_backend

# ルートの道具（commitlintなど）を入れる
npm install

# Gitのフック（lefthook）を入れる
npx lefthook install
```

Cloudflare版かVercel版を直すときは、そのアプリの依存も入れます。
pushのときのフックが、pushにそのアプリの変更が入っていれば、そのアプリの型検査とテストを流すためです。
Vercel版を直すときは、テストが使うRedisも立てておきます（Dockerが要ります）。

```sh
(cd apps/cloudflare && npm ci)   # Cloudflare版を直すとき
(cd apps/vercel && npm ci)       # Vercel版を直すとき
(cd apps/vercel && docker compose up -d redis)   # Vercel版のテストが使うRedis（127.0.0.1:6379）
```

`docs/`やPHP版だけを直したpushでは、両アプリの型検査とテストは流れません。

lefthookは、コミットとpushのときに次のことを確かめます。

| フック       | 確かめること                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `commit-msg` | コミットメッセージが[Conventional Commits](https://www.conventionalcommits.org/ja/)の形か（commitlint）  |
| `pre-commit` | stagedのTypeScriptにESLint（アプリごと。整形の崩れも見る）、PHPにPHP-CS-FixerとPHPStan（Dockerで動かす） |
| `pre-push`   | pushに変更が入っているアプリの型検査とテスト（Vercel版は`check:esm`も。Redisが要る）                     |

フックは、手段を問わず迂回しないでください（`--no-verify`、`LEFTHOOK=0`、`core.hooksPath`の変更、設定の一時的な無効化）。
落ちたら原因を直してから、もう一度コミットします。

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
docker compose up -d redis   # テストが使うRedis（127.0.0.1:6379）
npm run lint
npm run format           # Prettierで整形する（確かめるだけならformat:check）
npm run typecheck
npm run check:esm        # tscで出したものを素のNodeで読み、BCDiceを1回振る
npm test                 # カバレッジ100%を要求
npm run coverage:check   # npm testのあとで、100%を下回るファイルが無いかを確かめる（CIでも流す）
```

部屋のサーバーのテストは、本物のRedisを使います（テストのファイルごとに、キーの頭を分けます）。
CIでは、Redisのサービスのコンテナを立てます。

相対パスの`import`には、拡張子（`./foo.js`）を付けてください。
Vercelは型を検査せずにファイルごとに変換するので、拡張子が無いと本番で`ERR_MODULE_NOT_FOUND`になります。
`npm run typecheck`がこれを見つけます。

中は次のように分けています。

```text
apps/vercel/
 ├─ api/index.ts   Vercel Functionの入口。WebSocketも受けるNodeのHTTPサーバー（src/server/node.ts）をdefault exportする
 ├─ src/
 │   ├─ config/    環境変数の形（Valibotのスキーマ）と、値の読み方
 │   ├─ domain/    SkyWayのトークンを作る処理（JWTとチャンネルのスコープ）
 │   ├─ http/      Honoのアプリ、経路、CORSと設定を読むミドルウェア、エラー
 │   ├─ infra/     暗号とエンコードの小さな部品
 │   ├─ server/    部屋のサーバーのVercel側（Redis、Blob、部屋を受け持つインスタンスと中継、掃除）
 │   └─ core/      部屋のサーバーの中身。apps/cloudflareの写し
 ├─ contracts/     apps/cloudflareの写し
 ├─ test/          Vitestのテスト。test/shared/はapps/cloudflareの写し
 ├─ scripts/       カバレッジの確認、ESMの確認、手元で動かすサーバー
 ├─ public/        空のまま置く。Vercelにリポジトリ全体を静的なファイルとして公開させないため
 └─ vercel.json    リージョン（東京のhnd1）、Functionの最大実行時間、Cron、すべての経路を/apiへ送る書き換え
```

SkyWayのトークンを作る処理は、署名に使うHMAC、UUIDの生成、いまの時刻を外から受け取る関数にしてあり、テストではそれを差し替えます。

### Cloudflare版（`apps/cloudflare`）

```sh
cd apps/cloudflare
npm ci
npm run dev              # http://localhost:8787
npm run lint
npm run format           # Prettierで整形する（確かめるだけならformat:check）
npm run typecheck
npm test                 # Workersのランタイム（workerd）の中で。カバレッジ100%を要求
```

テストは`@cloudflare/vitest-pool-workers`が持つwranglerとworkerdで動きます。
`npm run dev`と`npm run deploy`も同じランタイムで動くよう、`wrangler`はその版に固定しています。
上げるときは、`@cloudflare/vitest-pool-workers`が使う版に合わせてください（CIで確かめます）。

## コミットとPull Request

コミットメッセージは、件名も本文も英語で、[Conventional Commits](https://www.conventionalcommits.org/ja/)の形`type(scope): subject`で書きます。
フロントエンド（Udonarium Axe）と同じ決まりです。

| 部分    | 決まり                                                                             |
| ------- | ---------------------------------------------------------------------------------- |
| type    | `feat`・`fix`・`docs`・`chore`・`style`・`refactor`・`test`・`perf`・`build`・`ci` |
| scope   | `php`・`vercel`・`cloudflare`・`ci`・`docs`など（例：`fix(cloudflare): …`）        |
| subject | 命令形で、小文字で始め、末尾にピリオドを付けない。72文字以内                       |
| body    | 任意。何より「なぜ」を書く。1行は100文字以内（commitlintが確かめる）               |

- 1つのコミットには、1つの論理的な変更だけを入れます。整形だけの変更や依存の更新は、別のコミットにします。
- 1つのPull Requestには、1つの変更だけを入れます。
- テストを足し、CIがすべて通ることを確かめます。
- `CHANGELOG.md`は手で直しません。リリースのときに自動で更新されます。

## コメントとテスト名

`apps/`の中のコードのコメント（`//`、`/* */`、`/** */`、PHPの`#`も）は英語で書きます。
`describe()`と`it()`に渡すテスト名も英語です。
フロントエンドと同じ決まりで、`docs/`とREADMEの本文は対象外です。

## 整形

TypeScriptのアプリは、Prettierで整形します。
設定はフロントエンドと同じです（シングルクォート、`printWidth: 120`、`trailingComma: 'es5'`）。
各アプリで`npm run format`を流すと整い、CIは`npm run format:check`で確かめます。
ESLintにPrettierを組み込んである（`eslint-plugin-prettier`、フロントエンドと同じ）ので、`npm run lint`とコミットのときのESLintも、整形の崩れを見つけます。
Markdownは表を手でそろえるので、Prettierの対象から外しています。
PHPは`bin/php-cs-fixer fix`で整えます。

詳しくは[テスト・CI・リリース](/development/ci)を見てください。

## セキュリティ

脆弱性を見つけたときは、公開のIssueには書かず、[GitHub Security Advisory](https://github.com/Xelltis/udonarium_axe_backend/security/advisories/new)から非公開で知らせてください。
