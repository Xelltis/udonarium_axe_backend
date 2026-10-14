# 部屋のプロトコル

[部屋のサーバー](/cloudflare/rooms)とAxeのあいだでやりとりするものの形です。
型と定数は`apps/cloudflare/contracts/protocol.ts`に、例は`apps/cloudflare/contracts/fixtures/`にあります。
このページの内容と食い違うときは、そちらが正しいものです。

## HTTP

| メソッド | パス                    | 内容                                  |
| -------- | ----------------------- | ------------------------------------- |
| `POST`   | `/v1/rooms`             | 部屋を作る                            |
| `GET`    | `/v1/rooms`             | 部屋の一覧                            |
| `GET`    | `/v1/rooms/:roomKey/ws` | 部屋に入る（WebSocketにつなぎ替える） |

どれも、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginのページからしか受けません。
ほかのOriginには`403 origin-not-allowed`を返します。
`POST`と`GET`の一覧はCORSのプリフライトにも答えます。

### `POST /v1/rooms`

```http
POST /v1/rooms
Origin: https://axe.example.com
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

| 状態  | 本文                          | 起きるとき                                   |
| ----- | ----------------------------- | -------------------------------------------- |
| `400` | `{"error":"invalid-request"}` | 本文がJSONでない、名前やパスワードの形が違う |
| `429` | `{"error":"rate-limited"}`    | 送信元から部屋を作る・入る回数が上限を超えた |

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

作られた順に、1000件まで返します。
`members`はいま入っている人数です。誰もいない部屋も、消えるまでは一覧に出ます。

### `GET /v1/rooms/:roomKey/ws`

WebSocketにつなぎ替えます（`101`）。
つなぎ替える前に断るときは、JSONで理由を返します。

| 状態  | コード               | 起きるとき                                    |
| ----- | -------------------- | --------------------------------------------- |
| `400` | `invalid-id`         | 部屋の鍵の形が違う                            |
| `403` | `origin-not-allowed` | Originが許可リストにない                      |
| `404` | `room-not-found`     | 部屋が無い（作られていないか、消えた）        |
| `426` | `upgrade-required`   | WebSocketの要求でない                         |
| `429` | `rate-limited`       | 送信元から部屋を作る・入る回数が上限を超えた  |
| `503` | `room-full`          | 部屋が受けるWebSocketの数（64本）に達している |

トークンやパスワードはURLに載せません。
パスワードは、つないだあとの`hello`で送ります。

## WebSocketのフレーム

- **バイナリのフレーム**：中身は、下の封筒をMessagePackにしたものです。フレーム全体をgzipしても構いません。先頭の2バイトが`1f 8b`ならgzipとみなします。サーバーは、1KiBを超えて縮むフレームをgzipして送ります。
- **テキストのフレーム**：生きているかの確認にだけ使います。`ping`を送ると`pong`が返ります。この応答は部屋のサーバーを起こさずに返るので、こまめに送っても料金に響きません。

省けるフィールドは、無くても`null`でも構いません（MessagePackは`undefined`を`nil`にするため）。

## クライアントから送るもの

### `hello`

つないで最初に送ります。これより前に別のものを送ると、`hello-required`で切られます。

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "peerId": "a1B2c3XyZq9W8e7r6-",
  "userId": "8c5b7f0e-2c1d-4e3f-9a8b-7c6d5e4f3a2b",
  "password": "secret"
}
```

- `peerId`は、SkyWay版と同じ形のピアIDです。英数字・`_`・`-`の64文字までに限ります。
- `password`は、パスワードのある部屋に入るときに付けます。
- `hello`のすぐあとに、返事を待たずに別のものを送っても構いません。入れたあとで順に処理します。

### `send`

イベントの束を送ります。

```json
{
  "type": "send",
  "to": "Zz9Yy8XyZq9W8e7r6-",
  "events": [
    { "eventName": "WRITING_A_MESSAGE_DETAIL", "data": "…", "sendFrom": "a1B2c3XyZq9W8e7r6-" }
  ]
}
```

- `to`を省けば、自分以外の全員に届きます。`to`を付ければ、その人にだけ届きます。いない人や自分を宛先にしたものは捨てます。
- `sendFrom`は、サーバーが受けた接続のピアIDで上書きします。ほかの人になりすますことはできません。
- 送り主には返しません。自分の送ったものは、Axeが自分で折り返しています。
- 1つの束に入れられるイベントは4096までです。

### `time`

`{"type":"time"}`を送ると、サーバーの時刻を返します。時計のずれを測るのに使います。

## サーバーから送るもの

| `type`    | 中身                                                                    | 送るとき             |
| --------- | ----------------------------------------------------------------------- | -------------------- |
| `welcome` | `protocolVersion`、`peerId`、`authorityPeerId`、`members`、`serverTime` | `hello`が通ったとき  |
| `join`    | `member`（`peerId`と`userId`）                                          | 誰かが入ったとき     |
| `leave`   | `peerId`                                                                | 誰かが抜けたとき     |
| `data`    | `from`（送り主のピアID）、`events`                                      | イベントを届けるとき |
| `time`    | `serverTime`（Unixミリ秒）                                              | `time`を受けたとき   |
| `error`   | `code`、`protocolVersion`                                               | 接続を閉じる前       |

- `welcome`の`members`には、つないだ本人とサーバーは入りません。
- サーバー自身のピアIDは`welcome`の`authorityPeerId`（`@authority`）で知らせます。ピアIDの形から推し量らないでください。
- `welcome`のすぐあとには、必ずサーバーのカタログ（`from`が`@authority`の`data`）が届きます。部屋が空でも、空のカタログが1件届きます。

## サーバーが中身を読むイベント

ほかのイベントは、中身を読まずにそのまま届けます。

| イベント                  | サーバーがすること                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_GAME_OBJECT`      | 版を比べ、新しければ置いて、宛先にかかわらずほかの全員に配る（→ [新しい方を勝たせる](/cloudflare/rooms#新しい方を勝たせる)） |
| `DELETE_GAME_OBJECT`      | 消して印を残し、宛先にかかわらずほかの全員に配る                                                                             |
| `FORGET_DELETED_OBJECTS`  | 消した印を外し、ほかの全員に配る                                                                                             |
| `SYNCHRONIZE_GAME_OBJECT` | 宛先がサーバーか、宛先なしなら、サーバーが答える。足りないものを取り寄せ、消したものは消させる                               |
| `REQUEST_GAME_OBJECT`     | 宛先がサーバーか、宛先なしなら、サーバーが持っているものを返す                                                               |
| `REQUEST_CATALOG`         | 宛先がサーバーか、宛先なしなら、サーバーのカタログを返す                                                                     |

カタログは、1つのイベントに2048件ずつ入れます。
宛先がほかの参加者になっている`SYNCHRONIZE_GAME_OBJECT`・`REQUEST_GAME_OBJECT`・`REQUEST_CATALOG`は、読まずにその人へ届けます。

## 接続を閉じる理由

サーバーは`error`を送ってから、close code `4000`、reasonに同じコードを付けて閉じます。

| コード              | 起きるとき                                                                         | つなぎ直して直るか |
| ------------------- | ---------------------------------------------------------------------------------- | :----------------: |
| `protocol-mismatch` | `hello`の`protocolVersion`がサーバーと違う。Axeを読み込み直して更新する            |                    |
| `room-not-found`    | 部屋が無い（作られていないか、消えた）                                             |                    |
| `room-full`         | 部屋にいる人が32人に達している                                                     |         ✅         |
| `wrong-password`    | パスワードが違うか、無い                                                           |                    |
| `hello-required`    | 最初のメッセージが`hello`でない                                                    |                    |
| `bad-message`       | MessagePackとして読めない、展開すると32MiBを超える、封筒の形が違う                 |                    |
| `too-many-messages` | 10秒のあいだに2000を超えるフレームを送った                                         |         ✅         |
| `replaced`          | 同じピアIDで新しい接続が入った。つなぎ直すと新しい方を追い出すので、つなぎ直さない |                    |

## 契約のフィクスチャ

`apps/cloudflare/contracts/`は、サーバー側が持ち主です。
Axeは同じ内容を写して使い、両側のテストが同じJSONを読みます。
npmには出していません。

| ファイル                 | 中身                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `protocol.ts`            | 封筒の型、定数、エラーのコード、版を比べる関数（`judgeUpdate`） |
| `fixtures/lww.json`      | 版を比べたときの期待値                                          |
| `fixtures/messages.json` | 封筒の例。サーバーが受け付けるもの・断るもの・送るもの          |
| `fixtures/errors.json`   | 接続を閉じる理由ごとの、起きるときとサーバーが送るもの          |

封筒の形を変えたときは、`PROTOCOL_VERSION`を上げます。
版の違うAxeは`protocol-mismatch`で断られ、読み込み直すよう案内されます。
