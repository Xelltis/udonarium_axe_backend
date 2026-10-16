# APIリファレンス（トークン発行）

PHP版とVercel版が受けるHTTPのAPIです。
Axeが使うのは`GET /v1/status`と`POST /v1/skyway2023/token`の2つで、どちらのサーバーでも同じように答えます。
エラーの本文の形など、細かいところはサーバーごとに違うので、それぞれの節で説明します。

## エンドポイントの一覧

| メソッド  | パス                   | PHP版 | Vercel版 | 内容                                     |
| --------- | ---------------------- | :---: | :------: | ---------------------------------------- |
| `GET`     | `/`                    |  ✅   |    ✅    | 動いているかの簡単な確認                 |
| `GET`     | `/v1/status`           |  ✅   |    ✅    | 動いているかの確認。Axeが最初に呼ぶ      |
| `POST`    | `/v1/skyway2023/token` |  ✅   |    ✅    | SkyWayのトークンを発行する。Axeが呼ぶ    |
| `POST`    | `/v1/skyway/tokens`    |       |    ✅    | 上と同じ。Vercel版で新しく使うときの名前 |
| `OPTIONS` | 上のPOSTのパス         |  ✅   |    ✅    | ブラウザのプリフライトに答える           |

## `GET /`

サーバーが動いていれば、JSONを返します。
Originの確認はしません。

```sh
curl https://backend.example.com/
```

| サーバー | 返す本文                                        |
| -------- | ----------------------------------------------- |
| PHP版    | `{"message":"Ready to serve your realm."}`      |
| Vercel版 | `{"message":"Hello udonarium-backend-vercel!"}` |

## `GET /v1/status`

動いていれば、`200`で`OK`（テキスト）を返します。
Axeは部屋に入る前にこれを呼び、サーバーが動いているかを確かめます。

```sh
# PHP版：Originは要りません
curl https://backend.example.com/v1/status

# Vercel版：許可したOriginを付けます
curl -H "Origin: https://axe.example.com" https://backend.example.com/v1/status
```

::: info Vercel版はOriginが要ります
Vercel版は、`/v1/`の下のすべてのリクエストでOriginを確かめます。
ブラウザのアドレスバーに`/v1/status`を入れて開くと、Originが付かないので`ORIGIN_REQUIRED`が返ります。
確かめるときは、上のように`curl`で`Origin`を付けてください。
:::

## `POST /v1/skyway2023/token`

SkyWayの認証トークンを発行します。

### リクエスト

```http
POST /v1/skyway2023/token
Origin: https://axe.example.com
Content-Type: application/json

{
  "formatVersion": 1,
  "channelName": "部屋のチャンネル名",
  "peerId": "自分のピアID"
}
```

| フィールド      | 型     | 内容                           |
| --------------- | ------ | ------------------------------ |
| `formatVersion` | 数値   | `1`だけを受け付けます          |
| `channelName`   | 文字列 | 入る部屋のSkyWayのチャンネル名 |
| `peerId`        | 文字列 | 自分のピアID                   |

- `Origin`は、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginのどれかでなければなりません。
- PHP版は、`Content-Type: application/json`でないリクエストを`415`で断ります。本文は64KBまでです。
- `channelName`と`peerId`の中身も確かめます（空、200バイト超、`*`や`\`を含むもの、`udonarium-lobby-`で始まる部屋名を断る）。理由は[トークン発行のしくみ](/token/#安全のための制限)にあります。

### レスポンス

```json
{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

トークンの中身は[トークン発行のしくみ](/token/#トークンの中身)にあります。

### Vercel版で付くヘッダー

Vercel版では、このパスは古い名前として残しているので、レスポンスに次のヘッダーが付きます。
動きは`POST /v1/skyway/tokens`と同じです。

```http
Deprecation: true
Link: </v1/skyway/tokens>; rel="successor-version"
```

## プリフライト（`OPTIONS`）

ブラウザは、`Content-Type: application/json`を付けたPOSTの前に、`OPTIONS`で送ってよいかを尋ねます。
許可したOriginからなら、`204`で次のヘッダーを返します。

| ヘッダー                       | PHP版                  | Vercel版              |
| ------------------------------ | ---------------------- | --------------------- |
| `Access-Control-Allow-Origin`  | 一致した許可リストの値 | リクエストのOrigin    |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS`   | `POST,GET,OPTIONS`    |
| `Access-Control-Allow-Headers` | `Content-Type, Accept` | `Content-Type,Accept` |
| `Access-Control-Max-Age`       | `86400`（1日）         | `86400`（1日）        |

## エラー

### PHP版

本文は`{"error": "<メッセージ>"}`の形です（`405`だけはテキスト）。

| 状態 | メッセージ                  | 起きるとき                                         |
| ---- | --------------------------- | -------------------------------------------------- |
| 400  | `Origin is required.`       | `Origin`ヘッダーがない                             |
| 400  | `Bad Request.`              | 本文がJSONでない、またはフィールドの値が正しくない |
| 403  | `Forbidden.`                | 許可していないOriginから来た                       |
| 404  | `Not Found.`                | そのパスが無い                                     |
| 405  | `Method Not Allowed`        | パスはあるが、そのメソッドは受け付けない           |
| 413  | `Request Entity Too Large.` | 本文が64KBを超えた                                 |
| 415  | `Unsupported Media Type.`   | `Content-Type`が`application/json`でない           |
| 500  | （本文なし）                | `.env`が見つからない・読めない、必須の値がない     |

`500`のときは、原因がPHPのエラーログに出ます。
`.env`を読めないと、`/v1/status`を含むすべてのリクエストが`500`になります。

### Vercel版

本文は`{"error": {"code": "<コード>", "message": "<説明>"}}`の形です。

| 状態 | コード              | 起きるとき                                         |
| ---- | ------------------- | -------------------------------------------------- |
| 400  | `ORIGIN_REQUIRED`   | `Origin`ヘッダーがない                             |
| 400  | `VALIDATION_FAILED` | 本文がJSONでない、またはフィールドの形が正しくない |
| 403  | `ORIGIN_FORBIDDEN`  | 許可していないOriginから来た                       |
| 500  | `CONFIG_INVALID`    | 環境変数が足りないか、形が違う                     |
| 500  | `INTERNAL_ERROR`    | それ以外の失敗                                     |
