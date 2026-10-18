# はじめに

このドキュメントは、Udonarium Axe（以下Axe）を配信する人が、Axeにつなぐサーバーを自分で置くためのものです。
サーバーを置くのが初めてでも進められるように書いています。

Axeは、HTMLとJavaScriptのファイルだけでできています。
ファイルを置けばブラウザで開けますが、参加者どうしをつなぐには、Axeの外にサーバーが要ります。
そのサーバーを置くのが、このドキュメントの目的です。
Axe本体の置きかたは、[Axeの利用ガイド](https://xelltis.github.io/udonarium_axe/)にあります。

## 2つの方式

Axeの配信には、2つの方式があります。
どちらにするかは、あなたが配信ごとに、Axeの`config.json`で決めます（→ [Axeの設定](/guide/client-config)）。

| 方式       | 参加者のつながりかた                                                       | 置くサーバー                             |
| ---------- | -------------------------------------------------------------------------- | ---------------------------------------- |
| SkyWay版   | 参加者どうしが、[SkyWay](https://skyway.ntt.com/)を使って直接つながる      | トークン発行サーバー（PHP版・Vercel版・Cloudflare版） |
| サーバー版 | 全員が部屋のサーバーにつながる。部屋のサーバーが卓の状態と画像と音声を持つ | 部屋のサーバー（Cloudflare版かVercel版） |

<ModeCompare />

サーバー版はAxe v1.68.0から使えます。
全員が抜けても卓が残る、裏向きのカードや秘話を見てはいけない人に届けない、などの違いがあります。
2つの違いと選びかたは、[どれを置くか](/guide/choose)で詳しく説明しています。

## 置くまでの流れ

<StepFlow numbered :steps="[
  { title: 'どれを置くか決める', text: '方式と置き場所を選ぶ', link: '/guide/choose' },
  { title: '準備する', text: 'アカウントとOriginを確かめる', link: '/guide/prepare' },
  { title: 'サーバーを置く', text: '選んだものの手順で' },
  { title: 'Axeにつなぐ', text: 'config.jsonにURLを書く', link: '/guide/client-config' },
  { title: '公開するなら', text: '費用・安全・規約を確かめる', link: '/operate/' },
]" />

1. [どれを置くか](/guide/choose)で、方式と置き場所を決めます。
2. [設置の準備](/guide/prepare)で、要るアカウントと、AxeのOriginを確かめます。
3. 決めたものの手順で、サーバーを置きます。

   | 置くもの                   | 手順                                                                              |
   | -------------------------- | --------------------------------------------------------------------------------- |
   | Vercel版（トークン発行）   | [SkyWayのアプリを作る](/skyway/app) → [Vercelに置く](/skyway/vercel)              |
   | PHP版                      | [SkyWayのアプリを作る](/skyway/app) → [レンタルサーバーに置く](/skyway/php)       |
   | Cloudflare版               | [Discordのアプリを作る](/server/discord) → [Cloudflareに置く](/server/cloudflare) |
   | Vercel版（部屋のサーバー） | [Discordのアプリを作る](/server/discord) → [Vercelに置く](/server/vercel)         |

4. [Axeの設定](/guide/client-config)で、Axeの`config.json`にサーバーのURLを書きます。
5. 身内の外にも開くなら、[運営する](/operate/)の章で、費用、安全のしくみ、預かるもの、規約を確かめます。

うまくいかないときは、[SkyWay版で困ったとき](/skyway/troubleshooting)か[サーバー版で困ったとき](/server/troubleshooting)を見てください。

## 用語

| 用語                 | 意味                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| トークン発行サーバー | SkyWay版で、AxeにSkyWayの認証トークン（使うための許可証）を作って渡すサーバー。PHP版・Vercel版・Cloudflare版           |
| 部屋のサーバー       | サーバー版で、参加者がつながる先。部屋ごとに卓の状態を持つ。Cloudflare版かVercel版                       |
| 部屋のアセット       | サーバー版で、部屋のサーバーが部屋ごとに預かる画像と音声                                                 |
| 席                   | 部屋に入っている1人ぶんの場所。役割（GM・PL・見学）を持つ                                                |
| Origin（オリジン）   | Webページの出どころ。`https://axe.example.com`のように、スキーム・ホスト名・ポートの組で、パスは含まない |
| CORS                 | ほかのOriginのページからのリクエストを受けるかどうかを、サーバーがブラウザに伝えるしくみ                 |
| JWT                  | 署名付きの小さなデータ。SkyWayのトークンや、ログインのトークンはJWTの形をしている                        |
| Worker               | Cloudflareの上で動く小さなプログラム。Cloudflare版はWorker                                               |
| R2                   | Cloudflareのファイル置き場。取り出すときの転送料がかからない                                             |
| Durable Objects      | Cloudflareの、状態を持てるWorker。Cloudflare版では部屋ごとに1つ置く                                      |
