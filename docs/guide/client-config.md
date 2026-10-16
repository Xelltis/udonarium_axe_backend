# Axeの設定（config.json）

Axeは、起動するときに配信先の`assets/config.json`を読み、どのサーバーにつなぐかを決めます。
サーバーを置いたら、最後にこのファイルを書き換えて、Axeとサーバーをつなぎます。

## ファイルの場所

Axeを配信している場所（`index.html`のあるフォルダ）の中の、`assets/config.json`です。

```text
（Axeの配信先）
 ├─ index.html
 └─ assets/
     └─ config.json   ← これ
```

Axeのリリースのzipには、ひな形の値が入った`assets/config.json`が最初から入っています。
配信先でこのファイルを開き、値を書き換えて、置き直してください。
テキストエディターの使いかたは、[設置の準備](/guide/prepare#テキストファイルを書く)にあります。

## SkyWay版のとき

`backend.url`に、トークン発行サーバー（PHP版かVercel版）のURLを書きます。

```json
{
  "backend": {
    "url": "https://backend.example.com"
  }
}
```

| 項目          | 内容                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `backend.url` | トークン発行サーバーのURL。サブディレクトリに置いたときは、そのパスまで書く（例：`https://example.com/backend`） |

URLの末尾の`/`は、あってもなくても構いません。
`transport`は書かないか、`"skyway"`にします。

## サーバー版のとき

`transport`を`"server"`にし、`backend.url`に部屋のサーバー（Cloudflare版かVercel版）のURLを書きます。

```json
{
  "transport": "server",
  "backend": {
    "url": "https://backend.example.com"
  }
}
```

| 項目          | 内容                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------- |
| `transport`   | `"server"`で部屋のサーバー、`"skyway"`か書かなければSkyWay版。知らない値はSkyWay版として読む |
| `backend.url` | 部屋のサーバーのURL。部屋とログインと画像と音声のAPIを、すべてここに送る                     |

部屋のサーバーの`ACCESS_CONTROL_ALLOW_ORIGIN`には、Axeを配信しているOriginを名前で書いておきます。
ログインのあとにAxeへ戻る先が、配信先のOriginにあるためです（`*`では戻れません）。

どちらの方式で配信するかは、配信ごとに選びます。
1つの配信の中で、部屋ごとに切り替えることはしません。

## サーバー側の設定との対応

| Axe側                   | サーバー側                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| Axeを配信しているOrigin | トークン発行サーバーか部屋のサーバーの`ACCESS_CONTROL_ALLOW_ORIGIN` |
| `backend.url`           | トークン発行サーバーか部屋のサーバーのURL                           |

## GitHub Actionsで配信している場合

Axeのリポジトリをフォークして、付属のデプロイ用ワークフロー（`.github/workflows/deploy.yml`）でS3とCloudFrontに配信している場合は、`config.json`を手で書く代わりに、GitHubのEnvironmentに値を入れます。
ワークフローが、ビルドのあとに`config.json`を作ります。

| 入れる場所                   | 名前          | 入る先        | 必須 |
| ---------------------------- | ------------- | ------------- | :--: |
| Secret                       | `BACKEND_URL` | `backend.url` |  ○   |
| Variable（Secretではない方） | `TRANSPORT`   | `transport`   |      |

`TRANSPORT`を書かなければ`skyway`です。
`skyway`と`server`のほかの値では、ワークフローが止まります。

## ローカル確認モード

Axeを「ローカル確認モード」で起動したときは、ネットワークを使わないので`config.json`は読まれません。
どのサーバーにもつなぎません。

## サーバー版でAxeがすること

サーバー版で配信すると、ロビーの上に「Discordでログイン」が出ます。
GMとPLはログインして入り、ログインしていない人は見学になります（→ [サーバー版のしくみ](/server/)）。
Axeがログインや画像と音声をどう扱うかは、[Axeの中の動き](/reference/client)にあります。
