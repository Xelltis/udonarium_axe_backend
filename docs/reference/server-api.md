# 部屋のサーバーのAPI

部屋のサーバー（Cloudflare版とVercel版）が受けるHTTPのAPIです。
どちらの部屋のサーバーも、同じ経路に同じ形で答えます。
部屋に入ったあとのWebSocketでのやりとりは、開発者向けの[部屋のプロトコル](https://github.com/Xelltis/udonarium_axe_backend/blob/main/development/protocol.md)にあります。

## エンドポイントの一覧

| メソッド  | パス                                                 | 内容                                                                                |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST`    | `/v1/rooms`                                          | 部屋を作る                                                                          |
| `GET`     | `/v1/rooms`                                          | 部屋の一覧                                                                          |
| `GET`     | `/v1/rooms/:roomKey`                                 | 部屋を鍵で1つ引く                                                                   |
| `DELETE`  | `/v1/rooms/:roomKey`                                 | 部屋を削除する（その部屋のGMだけ）                                                  |
| `GET`     | `/v1/rooms/:roomKey/ws`                              | 部屋に入る（WebSocketにつなぎ替える）                                               |
| `HEAD`    | `/v1/rooms/:roomKey/assets/:sha256`                  | 部屋のアセットが置かれているか                                                      |
| `GET`     | `/v1/rooms/:roomKey/assets/:sha256`                  | 部屋のアセットの中身                                                                |
| `PUT`     | `/v1/rooms/:roomKey/assets/:sha256`                  | 部屋のアセットを置く（その部屋のGMとPLだけ）                                        |
| `GET`     | `/v1/rooms/:roomKey/assets`                          | 部屋に置いてあるアセットの一覧                                                      |
| `POST`    | `/v1/rooms/:roomKey/assets/:sha256/uploads`          | 置き場所へ直接上げる先を受け取る（Vercel版だけ）                                    |
| `POST`    | `/v1/rooms/:roomKey/assets/:sha256/uploads/complete` | 直接上げ終えたことを知らせる（Vercel版だけ）                                        |
| `POST`    | `/v1/rooms/:roomKey/reports`                         | 運営する人に通報する（部屋の席ならだれでも）                                        |
| `GET`     | `/v1/auth/config`                                    | ログインに使える提供元（`{"providers":["discord"]}`）                               |
| `GET`     | `/v1/login/discord`                                  | ログインを始める（ページとして開く）                                                |
| `GET`     | `/v1/login/discord/callback`                         | Discordから戻ってくる（Discordのアプリに登録するURL）                               |
| `POST`    | `/v1/auth/token`                                     | ログインのコードかリフレッシュトークンを、トークンの組に替える                      |
| `POST`    | `/v1/auth/logout`                                    | ログアウト。そのリフレッシュトークンの系統を無効にする                              |
| `GET`     | `/v1/account`                                        | ログインしている人                                                                  |
| `DELETE`  | `/v1/account`                                        | アカウントを消す                                                                    |
| `GET`     | `/v1/contact`                                        | 運営する人に断られたときの問い合わせ先（`{"contact":"https://…"}`、無ければ`null`） |
| `OPTIONS` | 上のパス                                             | ブラウザのプリフライトに答える                                                      |
| `GET`     | `/admin`                                             | 運営する人の管理画面（→ [管理画面のAPI](#管理画面のapi)）                           |

## 共通の決まり

- ログインを始めるページ（`/v1/login/discord`）と、Discordから戻ってくるページ（`/v1/login/discord/callback`）のほかは、どれも`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginのページからしか受けません。ほかのOriginには`403 origin-not-allowed`を返します。この2つはブラウザがページとして開くもので、戻り先を許可したOriginに限ることで守ります。
- 許可したOriginからのプリフライトには`204`で答え、`Access-Control-Allow-Headers`で`Content-Type`、`Authorization`、`X-Asset-Name`を許します。`Access-Control-Max-Age: 86400`（1日）を付けます。
- `:roomKey`は部屋の鍵で、小文字の16進で書いた32文字です。`:sha256`は、中身のSHA-256を小文字の16進で書いた64文字です。どちらかの形が違えば`400 invalid-id`を返します。
- 運営する人がBANした送信元には、どれにも`403 banned`を返します。ログインの2つのページは、Axeの戻り先に`login_error=banned`を付けて戻します（→ [管理画面とBAN](/operate/admin#banで止まるもの)）。
- 運営する人が緊急停止しているあいだは、止めたもの（部屋を作る、部屋のアセットを置く）に`503 paused`を返します。新しいログインを止めているときは、Discordから戻ってくるページが、Axeの戻り先に`login_error=paused`を付けて戻します（→ [緊急停止](/operate/admin#緊急停止)）。
- `ADMIN_CONTACT_URL`を入れていると、`403 banned`と`503 paused`の本文に問い合わせ先を足します（`{"error":"banned","contact":"https://…"}`）。ログインの戻り先にも、`login_error=banned`と`login_error=paused`のときは`login_contact=<問い合わせ先>`を足します。`GET /v1/contact`は、BANした送信元からも読めます。
- エラーの本文は`{"error":"<コード>"}`の形です（→ [エラー](#エラー)）。
- 設定が読めないときは、`/v1/`の下のすべてのリクエストに`500 config-invalid`を返します（→ [設定項目](/server/configuration)）。

## 部屋

### `POST /v1/rooms`

ログインした人だけが作れます。作った人が、その部屋のGMになります。

```http
POST /v1/rooms
Origin: https://axe.example.com
Authorization: Bearer <アクセストークン>
Content-Type: application/json

{ "name": "金曜の卓", "password": "secret" }
```

| フィールド | 型     | 内容                                     |
| ---------- | ------ | ---------------------------------------- |
| `name`     | 文字列 | 部屋の名前。1〜255文字                   |
| `password` | 文字列 | 省けば、パスワードの無い部屋。64文字まで |

`201`で次を返します。

```json
{ "roomKey": "511c18c897b08d168145a815870cf90b", "roomId": "O46" }
```

- `roomKey`：部屋の鍵。128ビットの乱数を小文字の16進で書いた32文字。部屋に入るときと、招待リンクに使います。
- `roomId`：表示用の3文字。ほかの部屋とぶつかることがあります。部屋は`roomKey`で区別します。

| 状態  | 本文                            | 起きるとき                                             |
| ----- | ------------------------------- | ------------------------------------------------------ |
| `400` | `{"error":"invalid-request"}`   | 本文がJSONでない、名前やパスワードの形が違う           |
| `401` | `{"error":"login-required"}`    | アクセストークンが無いか、無効か、期限切れ             |
| `403` | `{"error":"banned"}`            | 運営する人が、そのDiscordのアカウントか送信元をBANした |
| `429` | `{"error":"rate-limited"}`      | 送信元から部屋を作る・入る・削除する回数が上限を超えた |
| `503` | `{"error":"login-unavailable"}` | この部屋のサーバーにログインが置かれていない           |

### `GET /v1/rooms`

```json
{
  "rooms": [
    {
      "roomKey": "511c18c8…",
      "roomId": "O46",
      "name": "金曜の卓",
      "hasPassword": true,
      "members": 2
    }
  ]
}
```

新しく作られた順に、1000件まで返します。
`members`はいま入っている人数です。誰もいない部屋も、消えるまでは一覧に出ます。
部屋のサーバーが落ちて、出ていく知らせが無いまま接続が切れたときは、見回りで数え直します（Cloudflare版は1時間ごと、Vercel版は30秒ごと）。

アクセストークンを付けて取ると、その人がGMの部屋に`"deletable": true`が付きます。
その部屋は、1000件に入らない古いものでも必ず返します。
トークンが無いか読めないとき、GMでない部屋には付きません。

一覧は、だれが取っても部屋の鍵を返します（→ [部屋の鍵を知っていれば入れる](/operate/security#部屋の鍵を知っていれば入れる)）。
送信元ごとの読み出しの上限（`READ_LIMITER`。部屋のアセットを読むのと合わせて1分600件）を超えると、`429 rate-limited`を返します。

### `GET /v1/rooms/:roomKey`

部屋の鍵で、1つの部屋を引きます。答えは`{ "room": { … } }`で、`room`の形は一覧の1件と同じです。
一覧に入らない古い部屋も引けるので、Axeは招待リンクを開いたときと、つなぎ直すときにこれを使います。
アクセストークンを付ければ、その人がGMの部屋に`"deletable": true`が付きます。
部屋が無ければ`404 room-not-found`、鍵の形が違えば`400 invalid-id`を返します。
数え方（`READ_LIMITER`）は一覧と同じです。

### `DELETE /v1/rooms/:roomKey`

部屋を削除します。削除できるのは、その部屋のGMだけです。

```http
DELETE /v1/rooms/511c18c897b08d168145a815870cf90b
Origin: https://axe.example.com
Authorization: Bearer <アクセストークン>
```

`204`を返します。
部屋にいる人には`room-deleted`を送ってから、接続を閉じます。
そのあとは保持期間が過ぎたときと同じく、部屋を一覧から外し、置いたものと部屋のアセットをすべて消します。
消しているあいだ（一覧やR2を待つあいだ）は、新しい接続も`hello`も`room-not-found`で断り、部屋のアセットのトークンも渡し直しません。保持期間が過ぎて消すときも同じです。

| 状態  | 本文                            | 起きるとき                                             |
| ----- | ------------------------------- | ------------------------------------------------------ |
| `400` | `{"error":"invalid-id"}`        | 部屋の鍵の形が違う                                     |
| `401` | `{"error":"login-required"}`    | アクセストークンが無いか、無効か、期限切れ             |
| `403` | `{"error":"not-game-master"}`   | その部屋のGMでない                                     |
| `404` | `{"error":"room-not-found"}`    | 部屋が無い（作られていないか、消えた）                 |
| `429` | `{"error":"rate-limited"}`      | 送信元から部屋を作る・入る・削除する回数が上限を超えた |
| `503` | `{"error":"login-unavailable"}` | この部屋のサーバーにログインが置かれていない           |

### `GET /v1/rooms/:roomKey/ws`

WebSocketにつなぎ替えます（`101`）。
つなぎ替える前に断るときは、JSONで理由を返します。

| 状態  | コード               | 起きるとき                                             |
| ----- | -------------------- | ------------------------------------------------------ |
| `400` | `invalid-id`         | 部屋の鍵の形が違う                                     |
| `403` | `origin-not-allowed` | Originが許可リストにない                               |
| `426` | `upgrade-required`   | WebSocketの要求でない                                  |
| `429` | `rate-limited`       | 送信元から部屋を作る・入る・削除する回数が上限を超えた |

部屋が無いとき（部屋を消しているあいだも）と、部屋が受けるWebSocketの数（64本）に達しているときは、つなぎ替えてから`error`（`room-not-found`・`room-full`）を送って閉じます。
HTTPのまま断ると、ブラウザには理由が読めないためです。

トークンやパスワードはURLに載せません。
パスワードは、つないだあとの`hello`で送ります。

## 部屋のアセット

### 部屋のアセットのトークン

部屋のアセットのAPIには、どれも`Authorization: Bearer <アセットのトークン>`が要ります。
ログインのアクセストークンでは通りません。

トークンは、部屋のサーバーが席に渡します。
部屋に入ったときの`welcome`に、`assetToken`と`assetTokenExpiresAt`（Unixミリ秒）が付いてきます。
トークンには、その部屋の鍵、席の役割、ユーザーID（`uid`）が入っています。
署名はHS256で、鍵は`SESSION_SECRET`です。15分で切れます。

Axeは切れる前に、WebSocketで`{"type":"asset-token"}`を送り、渡し直してもらいます。
サーバーは`{"type":"asset-token","assetToken":"…","expiresAt":…,"role":"pl"}`で答えます。`role`は、その席のいまの役割です。
PLをGMにしたときのように役割が変わったときも、サーバーから新しい役割のトークンを送ります。

読む（HEAD・GET）のは、その部屋の席にいる人ならだれでも（GM・PL・見学）できます。
置く（PUT）のはGMとPLだけで、見学のトークンには`403 not-a-player`を返します。
PUTのときは、部屋がまだあり、その人がいまGMかPLとして席にいるかを部屋のサーバーに尋ねます。トークンの期限が残っていても、部屋を削除したあとは`404 room-not-found`、見学に変えられた人や部屋から抜けた人には`403 not-a-player`を返します。Vercel版では、部屋を受け持つインスタンスが替わってから、その人が部屋に入り直すまでのあいだも、GMやPLに`403 not-a-player`を返します。入り直したあとに試し直せば置けます。
トークンが無いとき、切れたとき、ほかの部屋のものだったときは、`401 asset-token-required`を返します。
ハッシュや部屋の鍵を知っていても、トークンが無ければ読めません。
部屋を抜けた人が読めるのは、持っているトークンが切れるまで（長くて15分）です。

### `HEAD /v1/rooms/:roomKey/assets/:sha256`

置かれているかを返します。
中身は返さず、置き場所からファイルを開くこともしません。
Cloudflare版では、一度GETで配ってキャッシュにあるものは、GETと同じくキャッシュから答えます。このときはR2を読まず、読み出しの上限にも数えません。

| 状態  | 意味                                 |
| ----- | ------------------------------------ |
| `200` | 置かれている。ヘッダーはGETと同じ    |
| `401` | アセットのトークンが無いか、使えない |
| `404` | その部屋に置かれていない             |
| `429` | 送信元からの読み出しが上限を超えた   |

```sh
curl -I https://backend.example.com/v1/rooms/<部屋の鍵>/assets/<sha256> \
  -H "Origin: https://axe.example.com" \
  -H "Authorization: Bearer <アセットのトークン>"
```

### `GET /v1/rooms/:roomKey/assets/:sha256`

中身を返します。
返すのは、その部屋のトークンを持っている人（いま部屋にいる人）にだけです。

#### 返すヘッダー

| ヘッダー                        | 値                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `Content-Type`                  | 置いたときに中身から判定した形式（例：`image/png`）                                         |
| `Content-Length`                | 大きさ（バイト）                                                                            |
| `ETag`                          | 置き場所（R2かVercel Blob）がつけた値                                                       |
| `Cache-Control`                 | `private, max-age=604800, immutable`。ブラウザには7日置かせ、共有のキャッシュには置かせない |
| `Accept-Ranges`                 | `bytes`                                                                                     |
| `X-Content-Type-Options`        | `nosniff`                                                                                   |
| `Access-Control-Allow-Origin`   | リクエストの`Origin`                                                                        |
| `X-Asset-Name`                  | 置いたときの名前を`encodeURIComponent`したもの。名前が無ければ付けない                      |
| `Access-Control-Expose-Headers` | `X-Asset-Name`。ページから名前を読めるように                                                |

SVGのときだけ、`Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`も付けます。
理由は[安全のしくみ](/operate/security#svgはサンドボックスに入れて配る)にあります。

#### 条件付きリクエストと範囲指定

| リクエストのヘッダー                               | 動き                                       |
| -------------------------------------------------- | ------------------------------------------ |
| `If-None-Match`（ETagと一致）、`If-Modified-Since` | `304`（本文なし）                          |
| `If-Match`、`If-Unmodified-Since`（合わない）      | `412 precondition-failed`                  |
| `Range: bytes=10-19`                               | `206`と`Content-Range`で、その範囲だけ返す |

`If-None-Match`は、弱いETag（`W/"…"`）、複数のETagの並び、`*`も受け付けます。
置かれていないものには、条件にかかわらず`404`を返します。
ただし、運営する人が置かせないようにしたもの（→ [管理画面とBAN](/operate/admin#アップロード)）には、`451 blocked`を返します。HEADも同じです。

#### キャッシュ（Cloudflare版）

Cloudflare版では、同じデータセンターからの2回目以降のGETは、CloudflareのCache APIから返し、R2を読みません（`*.workers.dev`では効きません）。
同じURLへのHEADにも、条件付きリクエストと範囲指定にも、キャッシュから答えます。
キャッシュから返すときも、先にトークンを確かめます。
Vercel版には、このキャッシュはありません。

### `PUT /v1/rooms/:roomKey/assets/:sha256`

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
- 部屋がまだあり、その人がいまGMかPLとして席にいるかを部屋のサーバーに尋ねます。部屋が無ければ`404 room-not-found`、見学に変えられているか抜けていれば`403 not-a-player`を返します（Vercel版で受け持ちが替わった直後も同じ。入り直したあとに試し直せば通ります）。その部屋にすでに置かれているものは、何も書かないので、尋ねずに`200`（`exists`）を返します。
- `X-Asset-Name`には、ファイル名を`encodeURIComponent`したものを付けられます。255文字を超える分は切り（2つで1文字のものは半分で切らない）、読めなければ空にします。置き場所のメタデータ（`name`）に置き、[一覧](#get-v1-rooms-roomkey-assets)の`name`として返します。`HEAD`と`GET`の答えにも、同じヘッダーで付きます。
- `Content-Length`が要ります。本文は読みためずに、そのまま置き場所へ流します。
- 宣言された`Content-Type`は見ません。中身の先頭のバイトで形式を判定します。
- 本文のSHA-256が名前と合わなければ、何も置かずに`400 hash-mismatch`を返します。
- 中身を置いているあいだに部屋が削除されたときは、置いたものを消して`404 room-not-found`を返します。

| 状態  | 本文                                  | 意味                               |
| ----- | ------------------------------------- | ---------------------------------- |
| `201` | `{"id":"<sha256>","status":"stored"}` | 置いた                             |
| `200` | `{"id":"<sha256>","status":"exists"}` | すでに置かれていた（書き直さない） |

#### 受け付ける形式と上限

| 種類 | 形式                                       | 上限  |
| ---- | ------------------------------------------ | ----- |
| 画像 | PNG・JPEG・GIF・BMP・WebP・AVIF・HEIC・SVG | 2MiB  |
| 音声 | MP3・WAV・Ogg・FLAC・M4A・AAC              | 10MiB |

SVGは、BOM・XML宣言・コメント・DOCTYPEを読み飛ばしたあと、ルート要素が`<svg`で始まるものです。
これらの前置きは、先頭から4KiBに収まっている必要があります。
MP4やMOVの動画は受け付けません。
理由は[安全のしくみ](/operate/security#形式の判定)にあります。

### `GET /v1/rooms/:roomKey/assets`

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

### 置き場所へ直接上げる

1回の要求の本文に上限のある部屋のサーバーは、`welcome`の`assetUpload`でそれを知らせます。Vercel版は、Vercelの本文の上限（4.5MB）より少し小さい4,000,000バイトを`maxPutBytes`にしています。
`assetUpload`が無ければ（Cloudflare版）、種類ごとの上限（画像2MiB、音声10MiB）まで1回の`PUT`で置けます。

```json
{ "maxPutBytes": 4000000, "directUpload": true }
```

`maxPutBytes`を超えるものは、`PUT`では`413 too-large`になります。
`directUpload`が`true`なら、置き場所（Vercel Blob）へ直接上げます。

1. `POST /v1/rooms/:roomKey/assets/:sha256/uploads`に、`{"size":<大きさ>,"name":"<ファイル名>"}`を送ります。アセットのトークンを付けます。
2. `201`で`{ticket, upload:{url, method, headers, expiresAt}}`が返ります。すでに置かれていれば、`PUT`と同じ`200`（`"status":"exists"`）です。
3. `upload.url`へ、`upload.method`（`PUT`）と`upload.headers`で、中身だけを送ります。アセットのトークンは付けません。
4. `POST /v1/rooms/:roomKey/assets/:sha256/uploads/complete`に、`{"ticket":"<ticket>"}`を送ります。アセットのトークンを付けます。
5. 部屋のサーバーが中身の形式・大きさ・SHA-256を確かめ、置けたら`201`（`"status":"stored"`）を返します。

- 確かめる順とコードは`PUT`と同じです。数を絞るのは、1で尋ねたときだけです。
- `ticket`は、部屋・アセット・その人・大きさの約束で、15分で切れます。ほかの部屋やアセット、ほかの人のものは`400 invalid-request`になります。
- `upload`の先が使えるのは`expiresAt`（Unixミリ秒）までです。置き場所が、大きさと期限と上書きしないことを確かめます。
- 上げていないうちに知らせると`404 not-found`です。上げたものは、確かめたあと（置けても置けなくても）消します。
- 直接上げる流れの無い部屋のサーバーでは、どちらのパスも`404 not-found`です。

## 通報

### `POST /v1/rooms/:roomKey/reports`

部屋にいる人が、部屋の画像か音声、または部屋そのものを、運営する人に知らせます。
部屋のアセットのトークン（→ [部屋のアセットのトークン](#部屋のアセットのトークン)）で呼び、GM・PL・見学のだれでも通報できます。

```json
{ "target": "asset", "assetId": "0f0f…（SHA-256）", "reason": "他人の描いた絵を、作者に断らずに置いています" }
```

| フィールド | 型     | 内容                                       |
| ---------- | ------ | ------------------------------------------ |
| `target`   | 文字列 | `asset`（画像か音声）か`room`（部屋）      |
| `assetId`  | 文字列 | `asset`のときだけ。その画像か音声のSHA-256 |
| `reason`   | 文字列 | 理由。前後の空白を除いて1〜500文字         |

`201`で`{"id":"…"}`を返します。
部屋のサーバーは、通報した人（送信元のIPアドレス、ログインしていればDiscordのユーザーID、部屋のユーザーIDと役割）も一緒に残します。虚偽の通報をくり返す人を見分けて、BANできるようにするためです（→ [管理画面とBAN](/operate/admin#通報)）。

- 形が違えば`400 invalid-request`、トークンが無いか違う部屋のものなら`401 asset-token-required`を返します。
- 送信元ごとに、部屋を作る・入ると同じ回数の上限（1分に30回）に数えます。超えると`429 rate-limited`です。
- BANされたアカウントのトークンには`403 banned`を返します。

## ログインとアカウント

ログインの流れと、トークンの扱いは、開発者向けの[部屋のサーバーの中の動き](https://github.com/Xelltis/udonarium_axe_backend/blob/main/development/room-server.md#ログイン)にあります。
ここでは、Axeが呼ぶAPIの形を書きます。

### `POST /v1/auth/token`

```json
{ "grant_type": "login_code", "code": "…", "code_verifier": "…" }
```

```json
{ "grant_type": "refresh_token", "refresh_token": "…" }
```

どちらも、うまくいけば次を返します。

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…",
  "expiresIn": 900,
  "refreshToken": "…",
  "account": {
    "userId": "acct_8c5b7f0e-2c1d-4e3f-9a8b-7c6d5e4f3a2b",
    "name": "Kai",
    "avatarUrl": "https://cdn.discordapp.com/avatars/…"
  }
}
```

`account.userId`は、アカウントを消すまでは、同じDiscordのアカウントならいつも同じです。
消したあとに同じDiscordでログインすると、新しいアカウントとして別の`userId`になります。
`acct_`で始まり、ログインしていない人はこの形の`userId`を名乗れません。
部屋の`hello`の`userId`にはこれを使います。
手札やインベントリが、端末やタブをまたいでも同じ人のものになります。

| 状態  | コード              | 起きるとき                                                                                             |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `400` | `invalid-request`   | 本文の形が違う                                                                                         |
| `400` | `invalid-grant`     | コードかリフレッシュトークンが、無効・使用済み・期限切れ。運営する人がそのDiscordのアカウントをBANした |
| `429` | `rate-limited`      | 送信元から1分に60回を超えた                                                                            |
| `503` | `login-unavailable` | ログインが置かれていない                                                                               |

### アカウントを消す

`DELETE /v1/account`で、その人の情報（Discordの名前とアバターのURL）と、すべてのトークンを消します。
すでに出したアクセストークンは、切れるまでの最大15分は使えます。
部屋につながっている人も、トークンが切れて1分を過ぎると部屋から外れます（新しいトークンを受け取れないため）。
部屋の席の表には、消したアカウントの`userId`だけが残り、部屋が消えるときに一緒に消えます。
Axeはログインした人のカーソルにアカウントの名前とアバターを使うので、部屋に残る発言には、書いたときの名前とアバターの画像のURLが載ったままです。これも部屋が消えるまで残ります。

`GET`と`DELETE /v1/account`は、アクセストークンが無いか無効なら`401 login-required`を返し、アカウントは消しません。トークンのユーザーIDがいまのアカウントと同じときだけ答え、違えば（別の端末で消したあとも）`404 not-found`を返します。Axeは、`401`は消せなかったものとしてログインを残し、`404`は消せたものとします。
消したあと同じDiscordのアカウントでログインし直すと、新しいアカウントが作られます。
前のアカウントの残ったアクセストークンでは、新しいアカウントを見ることも消すこともできません。

### ログインに失敗したとき

戻り先のフラグメントに、`login_error`が付きます。

| `login_error`     | 起きるとき                                                   |
| ----------------- | ------------------------------------------------------------ |
| `denied`          | Discordの同意の画面で断った                                  |
| `provider-failed` | Discordとのやりとりに失敗した                                |
| `rate-limited`    | 送信元からのログインが1分に60回を超えた                      |
| `banned`          | 運営する人が、送信元かDiscordのアカウントをBANした           |
| `paused`          | 運営する人が、新しくログインすることを止めている（緊急停止） |

ログインを始めてから10分のうちにDiscordから戻らなかったとき（Discordのアカウントを作っていた、など）は、戻り先がわからないので、Axeには戻りません。
部屋のサーバーの`400`（`invalid-request`）の画面で止まるので、Axeからログインをやり直してください。
`SESSION_SECRET`をそのあいだに替えたときも同じです。

## 管理画面のAPI

管理画面（`/admin`）が呼ぶAPIです。
`ADMIN_DISCORD_IDS`を入れたときだけあり、画面の使いかたは[管理画面とBAN](/operate/admin)にあります。
管理画面のページから使うためのもので、スクリプトから呼ぶ鍵はありません。

- 入るには、`GET /admin/login`からDiscordでログインし（戻り先は`/admin/login/callback`）、そのあとパスキーで確かめます（下の表）。ログインは、HttpOnlyの`__Host-axe-admin` Cookie（HTTPSでないときは`axe-admin`）に置きます。
- どれも、`X-Admin-Request: 1`のヘッダーが要ります。無いか、Originが管理画面のものでないときは`403 forbidden`を返します。CORSのヘッダーは付けないので、ほかのサイトのページからは呼べません。
- ログインが無いか、切れたか、`ADMIN_DISCORD_IDS`から外されたか、すべての人をログアウトさせたあとのものは、`401 login-required`を返します。
- パスキーで確かめる前のログインは、`session`とパスキーの4つのほかは`403 passkey-required`です。
- 部屋の削除、画像と音声の削除、二度と置かせないことと、その解除、アカウントの削除、パスキーの追加と削除、すべての人をログアウトさせることは、パスキーで確かめてから5分を過ぎていると`403 reauth-required`を返します。パスキーで確かめ直してから、もう一度呼びます。
- BANの対象になりません。
- ログインの3つが入っていないときは、`503 login-unavailable`を返します。
- どの答えにも`Cache-Control: no-store`を付けます。

| メソッド | パス                                               | 内容                                                                                                                          |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/api/rooms`                                 | 部屋の一覧。新しいものから2000件まで。作った人のDiscordのIDとIPアドレス付き                                                   |
| `GET`    | `/admin/api/rooms/:roomKey/seats`                  | その部屋にいま入っている人                                                                                                    |
| `GET`    | `/admin/api/rooms/:roomKey/assets`                 | その部屋に置いてある画像と音声（ID、種類、大きさ、名前）                                                                      |
| `DELETE` | `/admin/api/rooms/:roomKey`                        | 部屋を削除する（GMでなくても）。`204`、無ければ`404 room-not-found`                                                           |
| `GET`    | `/admin/api/bans`                                  | BANの一覧                                                                                                                     |
| `POST`   | `/admin/api/bans`                                  | BANする。`201`で、足したBANを返す                                                                                             |
| `DELETE` | `/admin/api/bans?kind=…&value=…`                   | BANを解く。`204`、無ければ`404 not-found`                                                                                     |
| `GET`    | `/admin/api/activity`                              | 記録。新しいものから                                                                                                          |
| `GET`    | `/admin/api/assets?cursor=…`                       | 置き場所にあるすべての部屋のアセット（部屋の鍵、ID、種類、大きさ、名前、置いた時刻）を1ページずつ。続きがあれば`cursor`を返す |
| `GET`    | `/admin/api/rooms/:roomKey/assets/:sha256/content` | そのアセットの中身。`Content-Security-Policy: default-src 'none'; sandbox`を付ける。見たことを記録に残す                      |
| `DELETE` | `/admin/api/rooms/:roomKey/assets/:sha256`         | その部屋からアセットを消す。`204`                                                                                             |
| `POST`   | `/admin/api/assets/:sha256/block`                  | 二度と置かせないようにし、本文の`rooms`（部屋の鍵の配列、2000件まで）から消す。消せた数と消せなかった数を返す                 |
| `GET`    | `/admin/api/blocked`                               | 二度と置かせないもののIDの一覧                                                                                                |
| `DELETE` | `/admin/api/blocked/:sha256`                       | また置けるようにする。`204`                                                                                                   |
| `GET`    | `/admin/api/reports`                               | 参加者からの通報。新しいものから。通報した人も含む                                                                            |
| `PUT`    | `/admin/api/reports/:id`                           | 通報の状態を変える。本文は`{"status":"done"}`の形（`open`・`done`・`dismissed`）                                              |
| `GET`    | `/admin/api/pause`                                 | 緊急停止で止めているもの                                                                                                      |
| `PUT`    | `/admin/api/pause`                                 | 緊急停止で止めるものを決める。本文は`{"rooms":true,"uploads":false,"logins":false}`の形                                       |
| `GET`    | `/admin/api/tighten`                               | 回数の上限をどれだけ締めているか                                                                                              |
| `PUT`    | `/admin/api/tighten`                               | 回数の上限を締める。本文は`{"upload":4,"read":1,"room":2,"auth":1}`の形（それぞれ1・2・4・10）                                |
| `GET`    | `/admin/api/accounts/:discordId`                   | そのDiscordのユーザーIDのアカウント。無ければ`404 not-found`                                                                  |
| `DELETE` | `/admin/api/accounts/:discordId`                   | そのアカウントを削除する。`204`、無ければ`404 not-found`                                                                      |
| `GET`    | `/admin/api/settings`                              | いまの設定。秘密の値は、入っているかどうかだけ                                                                                |
| `GET`    | `/admin/api/storage`                               | 置き場所の使用量（最後に数えたときの大きさ・件数・時刻）と、知らせる量（`ADMIN_STORAGE_ALERT_GB`）                            |

ログインとパスキーのためのものです。

| メソッド | パス                            | 内容                                                            |
| -------- | ------------------------------- | --------------------------------------------------------------- |
| `GET`    | `/admin/login`                  | Discordへ送る（ページとして開く）                               |
| `GET`    | `/admin/login/callback`         | Discordから戻る。入れないときは、`/admin#denied=<理由>`へ戻す   |
| `POST`   | `/admin/api/logout`             | このログインを終える。`204`                                     |
| `GET`    | `/admin/api/session`            | だれが、どこまで確かめたか（`stage`は`discord`か`passkey`）     |
| `POST`   | `/admin/api/passkeys/options`   | パスキーを作るための値（`navigator.credentials.create`に渡す）  |
| `POST`   | `/admin/api/passkeys`           | 作ったパスキーを登録する。ログインも確かめたことになる。`201`   |
| `POST`   | `/admin/api/passkeys/challenge` | パスキーで確かめるための値（`navigator.credentials.get`に渡す） |
| `POST`   | `/admin/api/passkeys/verify`    | パスキーの署名で確かめる。`204`                                 |
| `GET`    | `/admin/api/passkeys`           | 自分のパスキーの一覧                                            |
| `DELETE` | `/admin/api/passkeys/:id`       | 自分のパスキーを消す。最後の1つは`409 last-passkey`             |
| `POST`   | `/admin/api/sessions/revoke`    | すべての運営する人のログインを終える。`204`                     |

`POST /admin/api/bans`の本文は、次の形です。

```json
{ "kind": "ip", "value": "203.0.113.0/24", "reason": "部屋を作り続けた", "hours": 24 }
```

| フィールド | 型     | 内容                                                                               |
| ---------- | ------ | ---------------------------------------------------------------------------------- |
| `kind`     | 文字列 | `ip`か`discord`                                                                    |
| `value`    | 文字列 | IPアドレスか範囲（→ [BANする](/operate/admin#banする)）、またはDiscordのユーザーID |
| `reason`   | 文字列 | 省けば空。200文字まで                                                              |
| `hours`    | 整数   | BANが続く時間（1以上）。省けば、解くまで続く                                       |

`value`は、置くときの形に直して返します（`203.0.113.9/24`は`203.0.113.0/24`、IPv6のアドレスは先頭の/64）。
解くときの`value`には、返ってきた形を使います。
形が違うときは`400 invalid-request`を返します。

## エラー

本文は`{"error":"<コード>"}`の形です。

| 状態 | コード                 | 起きるとき                                                                                                                                               |
| ---- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid-id`           | 名前が64文字の小文字16進でない、部屋の鍵の形が違う                                                                                                       |
| 400  | `invalid-request`      | 本文がJSONでない、名前やパスワードの形が違う。ログインの戻り先が許されていない                                                                           |
| 400  | `invalid-grant`        | ログインのコードやリフレッシュトークンが、無効・使用済み・期限切れ                                                                                       |
| 400  | `hash-mismatch`        | 本文のハッシュが名前と合わない                                                                                                                           |
| 400  | `invalid-challenge`    | 管理画面のパスキーの確かめで、値が古いか、使用済みか、ほかのログインのもの                                                                               |
| 400  | `passkey-refused`      | 管理画面で、作ったパスキーを受け付けられなかった                                                                                                         |
| 401  | `login-required`       | 部屋を作る・削除する、アカウントを見る・消すのに、アクセストークンが無いか無効。管理画面のAPIに、ログインが無いか切れている                              |
| 401  | `asset-token-required` | 部屋のアセットのトークンが無い・無効・期限切れ・ほかの部屋のもの                                                                                         |
| 401  | `passkey-refused`      | 管理画面で、パスキーの署名で確かめられなかった                                                                                                           |
| 403  | `origin-not-allowed`   | Originが`ACCESS_CONTROL_ALLOW_ORIGIN`にない                                                                                                              |
| 403  | `banned`               | 運営する人が、送信元かDiscordのアカウントをBANした（→ [管理画面とBAN](/operate/admin)）                                                                  |
| 403  | `forbidden`            | 管理画面のAPIを、`X-Admin-Request`のヘッダー無しか、ほかのOriginから呼んだ                                                                               |
| 403  | `passkey-required`     | 管理画面で、パスキーで確かめる前のログインで呼んだ。すでにパスキーがあるのに、確かめずに登録しようとした                                                 |
| 403  | `reauth-required`      | 管理画面の戻せない操作の前に、パスキーで確かめてから5分を過ぎている                                                                                      |
| 403  | `not-game-master`      | 部屋を削除しようとしたが、その部屋のGMでない                                                                                                             |
| 403  | `not-a-player`         | 見学のトークンで部屋のアセットを置こうとした。置くときに見学に変えられていたか、部屋から抜けていた。Vercel版で受け持ちが替わってから入り直すまでのあいだ |
| 404  | `not-found`            | その部屋にアセットが置かれていない（部屋と一緒に消えたときも）。アカウントがもう無い                                                                     |
| 404  | `room-not-found`       | 部屋が無い（作られていないか、消えた）                                                                                                                   |
| 409  | `passkey-exists`       | 管理画面で、もう登録してあるパスキーを登録しようとした                                                                                                   |
| 409  | `no-passkeys`          | 管理画面で、パスキーが無いのに確かめようとした                                                                                                           |
| 409  | `last-passkey`         | 管理画面で、最後のパスキーを消そうとした                                                                                                                 |
| 409  | `too-many-passkeys`    | 管理画面で、11個目のパスキーを登録しようとした                                                                                                           |
| 411  | `length-required`      | `PUT`に`Content-Length`がない                                                                                                                            |
| 412  | `precondition-failed`  | `GET`の`If-Match`か`If-Unmodified-Since`に合わない                                                                                                       |
| 413  | `too-large`            | 種類ごとの上限か、`maxPutBytes`を超えている                                                                                                              |
| 413  | `room-storage-full`    | 置くと、部屋の画像と音声の合計が`ROOM_STORAGE_LIMIT_MB`を超える（→ [設定項目](/server/configuration#room-storage-limit-mb)）                             |
| 415  | `unsupported-type`     | 受け付ける画像でも音声でもない                                                                                                                           |
| 426  | `upgrade-required`     | 部屋に入るURLを、WebSocketでなく開いた                                                                                                                   |
| 429  | `rate-limited`         | 送信元からの、アップロード、読み出し、部屋を作る・削除する・入る、ログインのどれかが上限を超えた                                                         |
| 451  | `blocked`              | 運営する人が、その名前のものを置かせないようにした                                                                                                       |
| 500  | `config-invalid`       | 設定が足りないか、形が違う（→ [設定項目](/server/configuration)）                                                                                        |
| 500  | `internal-error`       | それ以外の失敗（本文が`Content-Length`と合わないなど）                                                                                                   |
| 503  | `login-unavailable`    | ログインの3つが入っていない                                                                                                                              |
| 503  | `paused`               | 運営する人が、部屋を作ることか部屋のアセットを置くことを止めている（→ [緊急停止](/operate/admin#緊急停止)）                                              |

`config-invalid`のときは、足りない設定の名前がログに出ます。
`ADMIN_DISCORD_IDS`を入れていないときは、管理画面と管理画面のAPIに`404 not-found`を返します。
WebSocketでつないだあとに接続を閉じる理由は、[サーバー版で困ったとき](/server/troubleshooting#部屋に入れない・切れる)にあります。
