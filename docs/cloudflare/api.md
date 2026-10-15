# APIリファレンス（Cloudflare版）

Cloudflare版のアセットサーバーが受けるHTTPのAPIです。
Axeは、画像と音声を置くときと受け取るときに、これらを呼びます。
部屋のサーバーのAPIは[部屋のプロトコル](/cloudflare/protocol)にあります。

## エンドポイントの一覧

| メソッド  | パス                    | 内容                                                                   |
| --------- | ----------------------- | ---------------------------------------------------------------------- |
| `HEAD`    | `/v1/assets/:sha256`    | 置かれているかを返す                                                   |
| `GET`     | `/v1/assets/:sha256`    | 中身を返す。どのページからでも読める                                   |
| `PUT`     | `/v1/assets/:sha256`    | 置く。許可したOriginからのリクエストだけ受ける                         |
| `OPTIONS` | `/v1/assets/:sha256`    | ブラウザのプリフライトに答える                                         |
| `POST`    | `/v1/rooms`             | 部屋を作る（→ [部屋のプロトコル](/cloudflare/protocol#post-v1-rooms)） |
| `GET`     | `/v1/rooms`             | 部屋の一覧                                                             |
| `DELETE`  | `/v1/rooms/:roomKey`    | 部屋を削除する（その部屋のGMだけ）                                     |
| `GET`     | `/v1/rooms/:roomKey/ws` | 部屋に入る（WebSocket）                                                |

`:sha256`は、中身のSHA-256を**小文字の16進**で書いた64文字です。
それ以外の形の名前には`400 invalid-id`を返します。

## `HEAD /v1/assets/:sha256`

置かれているかを返します。
中身は返さず、R2からファイルを開くこともしません。

| 状態  | 意味                                   |
| ----- | -------------------------------------- |
| `200` | 置かれている。ヘッダーはGETと同じ      |
| `404` | 置かれていない、または保持期間を過ぎた |
| `429` | 送信元からのR2の読み出しが上限を超えた |

```sh
curl -I https://assets.example.com/v1/assets/<sha256>
```

## `GET /v1/assets/:sha256`

中身を返します。
どのOriginのページからでも読めます（`Access-Control-Allow-Origin: *`）。

### 返すヘッダー

| ヘッダー                       | 値                                                                         |
| ------------------------------ | -------------------------------------------------------------------------- |
| `Content-Type`                 | 置いたときに中身から判定した形式（例：`image/png`）                        |
| `Content-Length`               | 大きさ（バイト）                                                           |
| `ETag`                         | R2がつけた値                                                               |
| `Cache-Control`                | `public, max-age=<秒>, immutable`。`<秒>`は7日か、保持期間の残りの短いほう |
| `Accept-Ranges`                | `bytes`                                                                    |
| `X-Content-Type-Options`       | `nosniff`                                                                  |
| `Cross-Origin-Resource-Policy` | `cross-origin`                                                             |
| `Access-Control-Allow-Origin`  | `*`                                                                        |

SVGのときだけ、`Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`も付けます。
理由は[安全のしくみ](/cloudflare/security#svgはサンドボックスに入れて配る)にあります。

### 条件付きリクエストと範囲指定

| リクエストのヘッダー                               | 動き                                       |
| -------------------------------------------------- | ------------------------------------------ |
| `If-None-Match`（ETagと一致）、`If-Modified-Since` | `304`（本文なし）                          |
| `If-Match`、`If-Unmodified-Since`（合わない）      | `412 precondition-failed`                  |
| `Range: bytes=10-19`                               | `206`と`Content-Range`で、その範囲だけ返す |

`If-None-Match`は、弱いETag（`W/"…"`）、複数のETagの並び、`*`も受け付けます。
置かれていないものには、条件にかかわらず`404`を返します。

### キャッシュ

同じデータセンターからの2回目以降のGETは、CloudflareのCache APIから返し、R2を読みません（`*.workers.dev`では効きません）。
条件付きリクエストと範囲指定にも、キャッシュから答えます。

## `PUT /v1/assets/:sha256`

中身を置きます。

```http
PUT /v1/assets/<sha256>
Origin: https://axe.example.com
Content-Length: 12345

（画像か音声のバイト列）
```

- `Origin`は、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginのどれかでなければなりません。
- ログインを置いたWorkerでは、`Authorization: Bearer <アクセストークン>`が要ります（→ [ログインと役割](/cloudflare/login#アップロード)）。
- `Content-Length`が要ります。本文は読みためずに、そのままR2へ流します。
- 宣言された`Content-Type`は見ません。中身の先頭のバイトで形式を判定します。
- 本文のSHA-256が名前と合わなければ、何も置かずに`400 hash-mismatch`を返します。

| 状態  | 本文                                  | 意味                               |
| ----- | ------------------------------------- | ---------------------------------- |
| `201` | `{"id":"<sha256>","status":"stored"}` | 置いた                             |
| `200` | `{"id":"<sha256>","status":"exists"}` | すでに置かれていた（書き直さない） |

保持期間を過ぎたものにPUTが来たときは、置き直し、保持期間をそこから数え直します（`201`）。

### 受け付ける形式と上限

| 種類 | 形式                                       | 上限  |
| ---- | ------------------------------------------ | ----- |
| 画像 | PNG・JPEG・GIF・BMP・WebP・AVIF・HEIC・SVG | 2MiB  |
| 音声 | MP3・WAV・Ogg・FLAC・M4A・AAC              | 10MiB |

SVGは、BOM・XML宣言・コメント・DOCTYPEを読み飛ばしたあと、ルート要素が`<svg`で始まるものです。
これらの前置きは、先頭から4KiBに収まっている必要があります。
MP4やMOVの動画は受け付けません。
理由は[安全のしくみ](/cloudflare/security#形式の判定)にあります。

## プリフライト（`OPTIONS`）

| 求められたメソッド | 答え                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `GET`・`HEAD`      | どのOriginにも`204`。`Access-Control-Allow-Origin: *`で、求められたヘッダーをそのまま許す    |
| `PUT`              | 許可したOriginには`204`。`Access-Control-Allow-Headers: Content-Type`。ほかのOriginには`403` |

どちらも`Access-Control-Max-Age: 86400`（1日）を付けます。

## エラー

本文は`{"error": "<コード>"}`の形です。

| 状態 | コード                | 起きるとき                                             |
| ---- | --------------------- | ------------------------------------------------------ |
| 400  | `invalid-id`          | 名前が64文字の小文字16進でない                         |
| 400  | `hash-mismatch`       | 本文のハッシュが名前と合わない                         |
| 401  | `login-required`      | ログインを置いたWorkerで、PUTにアクセストークンが無い  |
| 403  | `origin-not-allowed`  | PUTのOriginが許可リストにない                          |
| 404  | `not-found`           | その名前の中身が置かれていないか、保持期間を過ぎた     |
| 411  | `length-required`     | PUTに`Content-Length`がない                            |
| 412  | `precondition-failed` | GETの`If-Match`か`If-Unmodified-Since`に合わない       |
| 413  | `too-large`           | 種類ごとの上限を超えている                             |
| 415  | `unsupported-type`    | 受け付ける画像でも音声でもない                         |
| 429  | `rate-limited`        | アップロードかR2の読み出しが、1分あたりの上限を超えた  |
| 451  | `blocked`             | 運営する人が、その名前のものを置かせないようにした     |
| 500  | `config-invalid`      | 環境変数が足りないか、形が違う                         |
| 500  | `internal-error`      | それ以外の失敗（本文が`Content-Length`と合わないなど） |

部屋のもの（`/v1/rooms`）のエラーは、[部屋のプロトコル](/cloudflare/protocol)にあります。
