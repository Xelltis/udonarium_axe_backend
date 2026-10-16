# Vercel版

[Vercel](https://vercel.com/)の上で動くバックエンドです。
TypeScriptの軽いWebフレームワーク[Hono](https://hono.dev/)で書いています。
1つのデプロイが、2つの役目を受け持てます。

| 役目                             | Axeの配信                           | 要るもの                                       |
| -------------------------------- | ----------------------------------- | ---------------------------------------------- |
| SkyWayのトークン発行             | SkyWay版（`transport`が`skyway`）   | SkyWayのアプリケーション                       |
| 部屋のサーバー（**サーバー版**） | サーバー版（`transport`が`server`） | Discordのアプリ、Redis、Vercel Blob（private） |

使うほうの環境変数だけを入れます（→ [設定項目](/vercel/configuration)）。

## SkyWayのトークン発行

- SkyWayの認証トークンを発行する（`POST /v1/skyway/tokens`と、Axeが使う`POST /v1/skyway2023/token`）
- 動いているかを返す（`GET /v1/status`）
- 許可したOriginのページからのリクエストだけを受ける（CORS）
- トークンの有効期間を変えられる（60秒〜7日）

APIの詳しい形は[APIリファレンス](/token/api)にあります。

## 部屋のサーバー

[Cloudflare版](/cloudflare/)と同じ部屋のサーバーです。
プロトコル、ログインと役割、見えない情報、サーバーで振るダイス、部屋のアセットは、Cloudflare版と同じコードで動きます（→ [部屋のサーバー](/cloudflare/rooms)、[ログインと役割](/cloudflare/login)、[部屋のプロトコル](/cloudflare/protocol)）。
Axeは、`backend.url`をVercelのデプロイに向けるだけで使えます（→ [Axe側の設定](/guide/client-config#サーバー版で配信するとき)）。

Cloudflare版との違いは、置き場所と、Vercelの決まりから来るものです。

| 項目                   | Cloudflare版                              | Vercel版                                                                                                     |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 部屋の状態             | 部屋ごとのDurable Object                  | Redis。部屋のWebSocketを持つインスタンスの1つが、部屋を受け持つ（ほかのインスタンスは、そこへ中継する）      |
| 部屋のアセット         | R2                                        | Vercel Blob（private）                                                                                       |
| WebSocketの長さ        | 切れない                                  | Functionの最大実行時間（無料プランは300秒）まで。その前に部屋のサーバーが閉じて、Axeにすぐつなぎ直してもらう |
| 1回のアップロード      | 種類ごとの上限（画像2MiB、音声10MiB）まで | 4,000,000バイトまで。それより大きい音声は、Blobへ直接上げる                                                  |
| 時間が過ぎた部屋を消す | 部屋ごとのアラーム                        | 一覧・作る・入るのついでと、1日1回のVercel Cron                                                              |

WebSocketをこちらから閉じるときと、部屋を受け持つインスタンスが替わったときは、Axeは静かにつなぎ直します。
ほかの人には、出たことも入ったことも見えません。
この2つ（静かにつなぎ直すことと、Blobへ直接上げること）は、Axe v1.68.0から行います。

VercelのWebSocketは、まだベータです（2026年10月時点）。

## 動く場所

| 項目       | 内容                                                         |
| ---------- | ------------------------------------------------------------ |
| 実行環境   | Vercel Functions（Node.js 24、Fluid compute）                |
| リージョン | 東京（`hnd1`）に固定。国内からの応答が速くなるようにしている |
| 費用       | 下を見てください                                             |

Vercelの無料プラン（Hobby）は、個人の非商用での利用が前提です。
団体での運用や商用で使うときは、Vercelの利用規約とプランを確かめてください。

### 費用

SkyWayのトークン発行だけなら、Vercelの無料プランで足りることがほとんどです。

部屋のサーバーは、WebSocketがつながっているあいだ、Functionが動き続けます。
Fluid computeでは、1つのインスタンスが多くのWebSocketを受けますが、つながっている時間のメモリの使用量が数えられます。
ほかにも、次のものに数や量の決まりがあります。

- Redis（Vercel Marketplace）：コマンドの数か、置く量
- Vercel Blob：置く量、読み書きの回数、転送量
- Vercel Cron：無料プランは1日1回まで

大きな卓や長い卓を続けて開くなら、それぞれの料金のページを確かめてください。

## 必要なもの

- Vercelのアカウント（GitHubのアカウントでログインできます）
- GitHubのアカウント（Deployボタンが、リポジトリをここに複製します）
- SkyWayのトークン発行に使うなら：SkyWayのアプリケーションIDとシークレットキー
- 部屋のサーバーに使うなら：Discordのアプリ、Redis（Vercel Marketplaceから）、Vercel Blobのストア（private）

## 次に読むもの

- [デプロイする（トークン発行）](/vercel/deploy)
- [部屋のサーバーとして置く](/vercel/rooms)
- [設定項目](/vercel/configuration)
- [困ったとき](/vercel/troubleshooting)
