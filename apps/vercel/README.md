# udonarium-backend-vercel

[![CI](https://github.com/Xelltis/udonarium-backend-vercel/actions/workflows/ci.yml/badge.svg)](https://github.com/Xelltis/udonarium-backend-vercel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Runtime: Vercel Functions](https://img.shields.io/badge/runtime-Vercel%20Functions-000000.svg?logo=vercel&logoColor=white)](https://vercel.com/docs/functions/runtimes/node-js)
[![Node.js: 24.x](https://img.shields.io/badge/node-24.x-5FA04E.svg?logo=node.js&logoColor=white)](./package.json)
[![Built with: Hono](https://img.shields.io/badge/built%20with-Hono-FF7A00.svg?logo=hono&logoColor=white)](https://hono.dev/)
[![Test Coverage](https://codecov.io/gh/Xelltis/udonarium-backend-vercel/graph/badge.svg)](https://codecov.io/gh/Xelltis/udonarium-backend-vercel)

ボードゲームオンラインセッション支援ツール [Udonarium](https://github.com/TK11235/udonarium) のバックエンド ([udonarium-backend](https://github.com/TK11235/udonarium-backend)) を、[Vercel Functions](https://vercel.com/docs/functions) 上で動作するように再実装したものです。

[SkyWay](https://skyway.ntt.com/) の認証トークン発行をはじめとした WebRTC セッションに必要なエンドポイントを、サーバーレスに配信できます。

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick Deploy](#quick-deploy)
- [Requirements](#requirements)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Local Development](#local-development)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Features

- **Vercel Functions (Node.js ランタイム) ネイティブ** — Fluid compute 上で動作し、東京リージョン (`hnd1`) に固定して国内から低レイテンシで応答します
- **[Hono](https://hono.dev/) ベースの軽量ルーター** — Web 標準 API のみで実装され、ランタイム非依存
- **[Valibot](https://valibot.dev/) によるスキーマ駆動のバリデーション** — 環境変数とリクエストボディを型安全に検証
- **依存性注入された純関数ドメイン** — JWT / HMAC / UUID 等を全て外部から注入し、テスト容易性を確保
- **Vitest による 100% テストカバレッジ** — `lines / functions / branches / statements` すべて 100% を CI で強制
- **後方互換エンドポイント** — 旧 `udonarium-backend` クライアントから移行できるよう deprecated エンドポイントも提供

## Architecture

```
                       ┌────────────────────┐
   Udonarium Web ──▶   │  Vercel Function   │ ──▶  SkyWay (WebRTC)
   (browser)           │  Node.js / hnd1    │
                       └────────────────────┘
                                 │
                       ┌─────────┴────────┐
                       │ JWT 発行 (HS256) │
                       │ CORS 検査         │
                       │ 設定スキーマ検証  │
                       └──────────────────┘
```

- ランタイム: **Vercel Functions / Node.js** (`api/index.ts` が `{ fetch }` を default export し、Vercel が Web Standard ハンドラとして解決)
- リージョン: **`hnd1` (東京)** を `vercel.json` の `regions` で固定 (未指定時の既定は `iad1` / ワシントン D.C.)
- ルート: `src/http/routes/`
- ミドルウェア: `src/http/middlewares/` (CORS / 設定ロード)
- ドメインロジック: `src/domain/skyway/` (SkyWay JWT 発行、Channel スコープ生成)
- インフラ実装: `src/infra/` (`crypto`, `encoding`, `url`)
- 設定: `src/config/` (環境変数の Valibot スキーマと正規化)

## Quick Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium-backend-vercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

1. 上記ボタンから Vercel にリポジトリを Clone & Import します
2. デプロイ画面で必須の環境変数 (`SKYWAY_APP_ID` / `SKYWAY_SECRET` / `ACCESS_CONTROL_ALLOW_ORIGIN`) を入力します
3. デプロイ完了後、フロントエンド ([Udonarium 本体](https://github.com/TK11235/udonarium)) からこの URL を参照するように設定します

## Requirements

- [Node.js](https://nodejs.org/) **24.x** (`package.json` の `engines.node` で固定。Vercel のビルドランタイムもこれに従います)
- [Vercel](https://vercel.com/) アカウントと [Vercel CLI](https://vercel.com/docs/cli)
- [SkyWay](https://skyway.ntt.com/) アカウントとアプリケーション (App ID / Secret)
- GitHub / GitLab / Bitbucket いずれかのアカウント (Vercel 連携用)

## Environment Variables

| 変数名                        | 必須 | 既定値  | 説明                                                      |
| :---------------------------- | :--: | :------ | :-------------------------------------------------------- |
| `SKYWAY_APP_ID`               |  ✅  | —       | SkyWay コンソールで発行したアプリケーション ID            |
| `SKYWAY_SECRET`               |  ✅  | —       | SkyWay の Secret Key (JWT 署名鍵)                         |
| `ACCESS_CONTROL_ALLOW_ORIGIN` |  ✅  | —       | 許可するオリジン。カンマ区切りで複数指定可 (`*` で全許可) |
| `SKYWAY_UDONARIUM_LOBBY_SIZE` |      | `3`     | ロビーチャンネルの分割サイズ                              |
| `SKYWAY_TOKEN_TTL_SECONDS`    |      | `86400` | 発行する JWT の有効期間 (秒)。`60` 〜 `604800` の範囲     |

ローカル開発時は Vercel から `.env` を取得できます。

```sh
npm run env   # vercel env pull
```

> [!WARNING]
> `SKYWAY_SECRET` は秘密情報です。リポジトリにコミットしないでください。`.env` は `.gitignore` 済みです。

## API Reference

すべてのエラーレスポンスは下記の形式で返ります。

```json
{ "error": { "code": "ERROR_CODE", "message": "human readable message" } }
```

| Code                | HTTP | 発生条件                                 |
| :------------------ | :--: | :--------------------------------------- |
| `CONFIG_INVALID`    | 500  | サーバー側の環境変数が不正               |
| `ORIGIN_REQUIRED`   | 400  | `Origin` ヘッダが未指定                  |
| `ORIGIN_FORBIDDEN`  | 403  | 許可されていないオリジンからのリクエスト |
| `VALIDATION_FAILED` | 400  | リクエストボディがスキーマと不一致       |
| `INTERNAL_ERROR`    | 500  | 想定外のエラー                           |

### `GET /`

サービスのヘルスチェック。CORS なし。

```sh
curl https://<your-deployment>/
# {"message":"Hello udonarium-backend-vercel!"}
```

### `GET /v1/status`

CORS 付きのシンプルなヘルスチェック。

```sh
curl -H "Origin: https://your-frontend.example" https://<your-deployment>/v1/status
# OK
```

### `POST /v1/skyway/tokens` _(推奨)_

SkyWay の JWT を発行します。Udonarium クライアントからセッション接続前に呼び出してください。

**Request**

```http
POST /v1/skyway/tokens
Origin: https://your-frontend.example
Content-Type: application/json

{
  "formatVersion": 1,
  "channelName": "your-room-channel",
  "peerId": "unique-peer-id"
}
```

**Response**

```json
{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

### `POST /v1/skyway2023/token` _(deprecated)_

旧 `udonarium-backend` クライアント互換のため残されたエンドポイント。レスポンスに以下のヘッダが付与されます。

```
Deprecation: true
Link: </v1/skyway/tokens>; rel="successor-version"
```

新規実装では `POST /v1/skyway/tokens` を使用してください。

## Local Development

```sh
# 依存関係インストール
npm install

# Vercel から環境変数を取得 (初回のみ)
npm run env

# 開発サーバー起動 (vercel dev)
npm start
```

開発サーバーはデフォルトで `http://localhost:3000` で起動します。

## Project Structure

```
.
├── api/
│   └── index.ts              # Vercel Function エントリーポイント ({ fetch } を default export)
├── src/
│   ├── config/               # 環境変数スキーマ・正規化
│   ├── domain/
│   │   └── skyway/           # SkyWay JWT 発行ドメイン
│   ├── http/
│   │   ├── app.ts            # Hono アプリ構築
│   │   ├── errors/           # AppError とハンドラ
│   │   ├── middlewares/      # CORS / 設定ロード
│   │   └── routes/           # ルート定義 (root, v1)
│   └── infra/                # crypto / encoding / url 実装
├── public/                   # 空。Vercel にリポジトリ全体を静的公開させないための出力先
├── test/                     # Vitest テスト (src と同形ツリー)
├── scripts/
│   └── check-coverage.ts     # カバレッジ閾値チェック
├── vercel.json               # ルーティング / 実行リージョン (hnd1) / 静的出力先
├── .github/workflows/ci.yml  # lint・typecheck・テスト・カバレッジ 100% の強制
└── vitest.config.ts          # Vitest 設定 (100% カバレッジ強制)
```

## Testing

[Vitest](https://vitest.dev/) と V8 カバレッジを使用しています。`lines / functions / branches / statements` の **100%** カバレッジが必須です。

```sh
# テスト実行 + カバレッジ収集
npm test

# 100% 閾値の追加チェック (カバレッジレポート生成後)
npm run coverage:check
```

カバレッジ HTML レポートは `coverage/index.html` に出力されます。

## Contributing

Pull Request 大歓迎です。以下を満たすようにお願いします。

1. ESLint / Prettier の設定に従ったフォーマット
2. 追加・変更したコードに対する Vitest テスト (カバレッジ 100% 維持)
3. 公開 API (エンドポイントや環境変数) を変更する場合は本 README を更新
4. **相対 import には拡張子を付ける** (`./foo.js` / `./foo/index.js`)。本プロジェクトは
   `"type": "module"` の純 ESM で、Vercel は TypeScript をバンドルせずファイル単位で
   トランスパイルするため、拡張子なしの指定は実行時に `ERR_MODULE_NOT_FOUND` になる。
   `tsconfig.json` の `moduleResolution: "nodenext"` が `npm run typecheck` で検出する

```sh
# Lint
npx eslint .

# Format
npx prettier --write .
```

バグ報告・機能要望は [Issues](https://github.com/Xelltis/udonarium-backend-vercel/issues) からお知らせください。

## License

[MIT License](./LICENSE) © Xelltis

## Acknowledgements

- [Udonarium](https://github.com/TK11235/udonarium) — ボードゲームオンラインセッション支援ツール本体
- [udonarium-backend](https://github.com/TK11235/udonarium-backend) — オリジナルのバックエンド実装
- [SkyWay](https://skyway.ntt.com/) — WebRTC プラットフォーム
- [Hono](https://hono.dev/) — Edge ファーストの Web フレームワーク
