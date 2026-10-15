# APIリファレンス（Cloudflare版）

Cloudflare版のWorkerが受ける、部屋のアセットのHTTPのAPIです。
Axeは、部屋の画像と音声を置くときと受け取るときに、これらを呼びます。
部屋そのもののAPIは[部屋のプロトコル](/cloudflare/protocol)にあります。

## エンドポイントの一覧

| メソッド  | パス                                | 内容                                                                   |
| --------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `HEAD`    | `/v1/rooms/:roomKey/assets/:sha256` | 部屋のアセットが置かれているかを返す                                   |
| `GET`     | `/v1/rooms/:roomKey/assets/:sha256` | 部屋のアセットの中身を返す                                             |
| `PUT`     | `/v1/rooms/:roomKey/assets/:sha256` | 部屋のアセットを置く（GMとPLだけ）                                     |
| `GET`     | `/v1/rooms/:roomKey/assets`         | 部屋に置いてあるアセットの一覧を返す                                   |
| `OPTIONS` | `/v1/rooms/:roomKey/assets/:sha256` | ブラウザのプリフライトに答える                                         |
| `POST`    | `/v1/rooms`                         | 部屋を作る（→ [部屋のプロトコル](/cloudflare/protocol#post-v1-rooms)） |
| `GET`     | `/v1/rooms`                         | 部屋の一覧（新しい順に1000件まで）                                     |
| `DELETE`  | `/v1/rooms/:roomKey`                | 部屋を削除する（その部屋のGMだけ）                                     |
| `GET`     | `/v1/rooms/:roomKey/ws`             | 部屋に入る（WebSocket）                                                |

`:roomKey`は部屋の鍵で、小文字の16進で書いた32文字です。
`:sha256`は、中身のSHA-256を**小文字の16進**で書いた64文字です。
どちらかの形が違えば`400 invalid-id`を返します。

## 部屋のアセットのトークン

部屋のアセットのAPIには、どれも`Authorization: Bearer <アセットのトークン>`が要ります。
ログインのアクセストークンでは通りません。

トークンは、部屋のサーバーが席に渡します。
部屋に入ったときの`welcome`に、`assetToken`と`assetTokenExpiresAt`（Unixミリ秒）が付いてきます（→ [部屋のプロトコル](/cloudflare/protocol)）。
トークンには、その部屋の鍵、席の役割、ユーザーID（`uid`）が入っています。
署名はHS256で、鍵は`SESSION_SECRET`です。15分で切れます。

Axeは切れる前に、WebSocketで`{"type":"asset-token"}`を送り、渡し直してもらいます。
サーバーは`{"type":"asset-token","assetToken":"…","expiresAt":…,"role":"pl"}`で答えます。`role`は、その席のいまの役割です。
PLをGMにしたときのように役割が変わったときも、サーバーから新しい役割のトークンを送ります。

読む（HEAD・GET）のは、その部屋の席にいる人ならだれでも（GM・PL・見学）できます。
置く（PUT）のはGMとPLだけで、見学のトークンには`403 not-a-player`を返します。
PUTのときは、部屋がまだあり、その人がいまもGMかPLかを部屋のサーバーに尋ねます。トークンの期限が残っていても、部屋を削除したあとは`404 room-not-found`、見学に変えられた人には`403 not-a-player`を返します。
トークンが無いとき、切れたとき、ほかの部屋のものだったときは、`401 asset-token-required`を返します。
ハッシュや部屋の鍵を知っていても、トークンが無ければ読めません。
部屋を抜けた人が読めるのは、持っているトークンが切れるまで（長くて15分）です。

どのリクエストも、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginからしか受けません。
ほかのOriginには`403 origin-not-allowed`を返します。

## `HEAD /v1/rooms/:roomKey/assets/:sha256`

置かれているかを返します。
中身は返さず、R2からファイルを開くこともしません。
一度GETで配ってキャッシュにあるものは、GETと同じくキャッシュから答えます。このときはR2を読まず、読み出しの上限にも数えません。

| 状態  | 意味                                   |
| ----- | -------------------------------------- |
| `200` | 置かれている。ヘッダーはGETと同じ      |
| `401` | アセットのトークンが無いか、使えない   |
| `404` | その部屋に置かれていない               |
| `429` | 送信元からのR2の読み出しが上限を超えた |

```sh
curl -I https://backend.example.com/v1/rooms/<部屋の鍵>/assets/<sha256> \
  -H "Origin: https://axe.example.com" \
  -H "Authorization: Bearer <アセットのトークン>"
```

## `GET /v1/rooms/:roomKey/assets/:sha256`

中身を返します。
返すのは、その部屋のトークンを持っている人（いま部屋にいる人）にだけです。

### 返すヘッダー

| ヘッダー                      | 値                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `Content-Type`                | 置いたときに中身から判定した形式（例：`image/png`）                                         |
| `Content-Length`              | 大きさ（バイト）                                                                            |
| `ETag`                        | R2がつけた値                                                                                |
| `Cache-Control`               | `private, max-age=604800, immutable`。ブラウザには7日置かせ、共有のキャッシュには置かせない |
| `Accept-Ranges`               | `bytes`                                                                                     |
| `X-Content-Type-Options`      | `nosniff`                                                                                   |
| `Access-Control-Allow-Origin` | リクエストの`Origin`                                                                        |

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
同じURLへのHEADにも、条件付きリクエストと範囲指定にも、キャッシュから答えます。
キャッシュから返すときも、先にトークンを確かめます。

## `PUT /v1/rooms/:roomKey/assets/:sha256`

中身をその部屋に置きます。

```http
PUT /v1/rooms/<部屋の鍵>/assets/<sha256>
Origin: https://axe.example.com
Authorization: Bearer <アセットのトークン>
Content-Length: 12345
X-Asset-Name: dragon.png

（画像か音声のバイト列）
```

- `Origin`は、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginのどれかでなければなりません。
- その部屋のGMかPLのアセットのトークンが要ります。見学のトークンには`403 not-a-player`を返します。
- 部屋がまだあり、その人がいまもGMかPLかを部屋のサーバーに尋ねます。部屋が無ければ`404 room-not-found`、見学に変えられていれば`403 not-a-player`を返します。
- `X-Asset-Name`には、ファイル名を`encodeURIComponent`したものを付けられます。255文字を超える分は切り、読めなければ空にします。R2のカスタムメタデータ（`name`）に置き、[一覧](#get-v1-rooms-roomkey-assets)の`name`として返します。
- `Content-Length`が要ります。本文は読みためずに、そのままR2へ流します。
- 宣言された`Content-Type`は見ません。中身の先頭のバイトで形式を判定します。
- 本文のSHA-256が名前と合わなければ、何も置かずに`400 hash-mismatch`を返します。

| 状態  | 本文                                  | 意味                               |
| ----- | ------------------------------------- | ---------------------------------- |
| `201` | `{"id":"<sha256>","status":"stored"}` | 置いた                             |
| `200` | `{"id":"<sha256>","status":"exists"}` | すでに置かれていた（書き直さない） |

### 受け付ける形式と上限

| 種類 | 形式                                       | 上限  |
| ---- | ------------------------------------------ | ----- |
| 画像 | PNG・JPEG・GIF・BMP・WebP・AVIF・HEIC・SVG | 2MiB  |
| 音声 | MP3・WAV・Ogg・FLAC・M4A・AAC              | 10MiB |

SVGは、BOM・XML宣言・コメント・DOCTYPEを読み飛ばしたあと、ルート要素が`<svg`で始まるものです。
これらの前置きは、先頭から4KiBに収まっている必要があります。
MP4やMOVの動画は受け付けません。
理由は[安全のしくみ](/cloudflare/security#形式の判定)にあります。

## `GET /v1/rooms/:roomKey/assets`

その部屋に置いてあるアセットの一覧を返します。
だれのカタログにも載っていないのに部屋には残っている画像や音声を、部屋に入った人が取りに行くためのものです。
部屋のアセットのほかのAPIと同じく、その部屋のアセットのトークンが要ります。

```json
{
  "assets": [
    {
      "id": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "type": "image/png",
      "size": 1024,
      "name": "dragon.png"
    }
  ]
}
```

| フィールド | 内容                                                       |
| ---------- | ---------------------------------------------------------- |
| `id`       | 中身のSHA-256（小文字の16進）                              |
| `type`     | 置いたときに中身から判定した形式（例：`image/png`）        |
| `size`     | 大きさ（バイト）                                           |
| `name`     | 置いたときに`X-Asset-Name`で付いてきた名前。無ければ空文字 |

- 応答には`Cache-Control: private, no-store`を付けます。
- 送信元ごとの読み出しの上限（`READ_LIMITER`）に数えます。超えると`429 rate-limited`を返します。
- 返すのは1万件までです。

| 状態  | 意味                                 |
| ----- | ------------------------------------ |
| `200` | 一覧（置いてあるものが無ければ空）   |
| `400` | 部屋の鍵の形が違う                   |
| `401` | アセットのトークンが無いか、使えない |
| `429` | 送信元からの読み出しが上限を超えた   |

## プリフライト（`OPTIONS`）

許可したOriginからのプリフライトには`204`で答え、`Access-Control-Allow-Headers`で`Content-Type`、`Authorization`、`X-Asset-Name`を許します。
部屋・部屋のアセット・ログイン・アカウントのAPIは、どれも同じように答えます。
ほかのOriginには`403 origin-not-allowed`を返します。
`Access-Control-Max-Age: 86400`（1日）を付けます。

## エラー

本文は`{"error": "<コード>"}`の形です。

| 状態 | コード                 | 起きるとき                                                      |
| ---- | ---------------------- | --------------------------------------------------------------- |
| 400  | `invalid-id`           | 名前が64文字の小文字16進でない、部屋の鍵の形が違う              |
| 400  | `hash-mismatch`        | 本文のハッシュが名前と合わない                                  |
| 401  | `asset-token-required` | アセットのトークンが無い・無効・期限切れ・ほかの部屋のもの      |
| 403  | `not-a-player`         | 見学のトークンで置こうとした。PUTのときに見学に変えられていた   |
| 403  | `origin-not-allowed`   | Originが許可リストにない                                        |
| 404  | `not-found`            | その部屋に置かれていない（部屋が消えて、一緒に消えたときも）    |
| 404  | `room-not-found`       | PUTのときに部屋がもう無い（削除したか、保持期間を過ぎて消えた） |
| 411  | `length-required`      | PUTに`Content-Length`がない                                     |
| 412  | `precondition-failed`  | GETの`If-Match`か`If-Unmodified-Since`に合わない                |
| 413  | `too-large`            | 種類ごとの上限を超えている                                      |
| 415  | `unsupported-type`     | 受け付ける画像でも音声でもない                                  |
| 429  | `rate-limited`         | アップロードか、R2の読み出しと一覧が、1分あたりの上限を超えた   |
| 451  | `blocked`              | 運営する人が、その名前のものを置かせないようにした              |
| 500  | `config-invalid`       | 環境変数が足りないか、形が違う                                  |
| 500  | `internal-error`       | それ以外の失敗（本文が`Content-Length`と合わないなど）          |

部屋そのもの（作る・一覧・削除・入る）のエラーは、[部屋のプロトコル](/cloudflare/protocol)にあります。
ログインとアカウントのAPI（`/v1/auth/*`・`/v1/account`）は、[ログインと役割](/cloudflare/login#api)にあります。
