# Vercel版

SkyWay版の配信で使う認証トークンを発行するサーバーを、[Vercel](https://vercel.com/)の上で動かすものです。
TypeScriptの軽いWebフレームワーク[Hono](https://hono.dev/)で書いています。
Deployボタンを押して環境変数を入れるだけで動き、サーバーの管理は要りません。

## できること

- SkyWayの認証トークンを発行する（`POST /v1/skyway/tokens`と、Axeが使う`POST /v1/skyway2023/token`）
- 動いているかを返す（`GET /v1/status`）
- 許可したOriginのページからのリクエストだけを受ける（CORS）
- トークンの有効期間を変えられる（60秒〜7日）

APIの詳しい形は[APIリファレンス](/token/api)にあります。

## 動く場所

| 項目       | 内容                                                         |
| ---------- | ------------------------------------------------------------ |
| 実行環境   | Vercel Functions（Node.js 24）                               |
| リージョン | 東京（`hnd1`）に固定。国内からの応答が速くなるようにしている |
| 費用       | Vercelの無料プラン（Hobby）で足りることがほとんど            |

Vercelの無料プラン（Hobby）は、個人の非商用での利用が前提です。
団体での運用や商用で使うときは、Vercelの利用規約とプランを確かめてください。

## 必要なもの

- Vercelのアカウント（GitHubのアカウントでログインできます）
- GitHubのアカウント（Deployボタンが、リポジトリをここに複製します）
- SkyWayのアプリケーションIDとシークレットキー

## 次に読むもの

- [デプロイする](/vercel/deploy)
- [設定項目](/vercel/configuration)
- [困ったとき](/vercel/troubleshooting)
