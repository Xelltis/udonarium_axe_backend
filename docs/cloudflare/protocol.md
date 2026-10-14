# 部屋のプロトコル

[部屋のサーバー](/cloudflare/rooms)とAxeのあいだでやりとりするものの形です。
型と定数は`apps/cloudflare/contracts/protocol.ts`に、例は`apps/cloudflare/contracts/fixtures/`にあります。
このページの内容と食い違うときは、そちらが正しいものです。
いまの版は**2**です。ログインのAPIは[ログインと役割](/cloudflare/login)にあります。

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

| 状態  | 本文                            | 起きるとき                                   |
| ----- | ------------------------------- | -------------------------------------------- |
| `400` | `{"error":"invalid-request"}`   | 本文がJSONでない、名前やパスワードの形が違う |
| `401` | `{"error":"login-required"}`    | アクセストークンが無いか、無効か、期限切れ   |
| `429` | `{"error":"rate-limited"}`      | 送信元から部屋を作る・入る回数が上限を超えた |
| `503` | `{"error":"login-unavailable"}` | このWorkerにログインが置かれていない         |

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
  "protocolVersion": 2,
  "peerId": "a1B2c3XyZq9W8e7r6-",
  "userId": "8c5b7f0e-2c1d-4e3f-9a8b-7c6d5e4f3a2b",
  "password": "secret",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…",
  "invite": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…"
}
```

- `peerId`は、SkyWay版と同じ形のピアIDです。英数字・`_`・`-`の64文字までに限ります。
- `password`は、パスワードのある部屋に入るときに付けます。
- `accessToken`は、ログインしているときに付けます。付けなければ見学（`guest`）として入ります。付けるなら、`userId`はアカウントの`userId`と同じにします。違うと`unauthorized`で切られます。
- `invite`は、招待リンクに付いてきた招待です。ログインした人がその部屋に初めて入るときの役割になります。
- `hello`のすぐあとに、返事を待たずに別のものを送っても構いません。入れたあとで順に処理します。

### `send`

イベントの束を送ります。

```json
{
  "type": "send",
  "to": "Zz9Yy8XyZq9W8e7r6-",
  "events": [
    {
      "eventName": "WRITING_A_MESSAGE_DETAIL",
      "data": "…",
      "sendFrom": "a1B2c3XyZq9W8e7r6-"
    }
  ]
}
```

- `to`を省けば、自分以外の全員に届きます。`to`を付ければ、その人にだけ届きます。いない人や自分を宛先にしたものは捨てます。
- `sendFrom`は、サーバーが受けた接続のピアIDで上書きします。ほかの人になりすますことはできません。
- 送り主には返しません。自分の送ったものは、Axeが自分で折り返しています。
- 1つの束に入れられるイベントは4096までです。

### `time`

`{"type":"time"}`を送ると、サーバーの時刻を返します。時計のずれを測るのに使います。

### `invite`

`{"type":"invite","role":"pl"}`を送ると、その役割で入れる招待を返します。GMだけが作れます（→ [招待](/cloudflare/login#招待)）。

## サーバーから送るもの

| `type`    | 中身                                                                            | 送るとき             |
| --------- | ------------------------------------------------------------------------------- | -------------------- |
| `welcome` | `protocolVersion`、`peerId`、`authorityPeerId`、`role`、`members`、`serverTime` | `hello`が通ったとき  |
| `join`    | `member`（`peerId`、`userId`、`role`）                                          | 誰かが入ったとき     |
| `leave`   | `peerId`                                                                        | 誰かが抜けたとき     |
| `data`    | `from`（送り主のピアID）、`events`                                              | イベントを届けるとき |
| `time`    | `serverTime`（Unixミリ秒）                                                      | `time`を受けたとき   |
| `invite`  | `role`、`invite`、`expiresAt`。GMでなければ`invite`と`expiresAt`は`null`        | `invite`を受けたとき |
| `error`   | `code`、`protocolVersion`                                                       | 接続を閉じる前       |

- `welcome`の`role`は、サーバーが決めた自分の役割（`gm`・`pl`・`guest`）です。自分の`PeerCursor`の`role`はこれにします。
- `welcome`の`members`には、つないだ本人とサーバーは入りません。
- サーバー自身のピアIDは`welcome`の`authorityPeerId`（`@authority`）で知らせます。ピアIDの形から推し量らないでください。
- `welcome`のすぐあとには、必ずサーバーのカタログ（`from`が`@authority`の`data`）が届きます。部屋が空でも、空のカタログが1件届きます。

## サーバーが中身を読むイベント

ほかのイベントは、中身を読まずにそのまま届けます。

| イベント                  | サーバーがすること                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_GAME_OBJECT`      | 版を比べ、新しければ置いて、宛先にかかわらずほかの全員に配る（→ [新しい方を勝たせる](/cloudflare/rooms#新しい方を勝たせる)） |
| `DELETE_GAME_OBJECT`      | 消して印を残し、宛先にかかわらずほかの全員に配る                                                                             |
| `FORGET_DELETED_OBJECTS`  | 消した印を外し、ほかの全員に配る。見学者からのものは受けない                                                                 |
| `ROLE_REQUEST`            | 宛先がサーバーか、宛先なしなら、役割を変える（→ [役割を変える](/cloudflare/login#役割を変える)）                             |
| `ROLL_REQUEST`            | 宛先がサーバーか、宛先なしなら、ダイスを振って結果の発言を全員に配る（→ [サーバーで振るダイス](#サーバーで振るダイス)）      |
| `SYNCHRONIZE_GAME_OBJECT` | 宛先がサーバーか、宛先なしなら、サーバーが答える。足りないものを取り寄せ、消したものは消させる                               |
| `REQUEST_GAME_OBJECT`     | 宛先がサーバーか、宛先なしなら、サーバーが持っているものを返す                                                               |
| `REQUEST_CATALOG`         | 宛先がサーバーか、宛先なしなら、サーバーのカタログを返す                                                                     |

カタログは、1つのイベントに2048件ずつ入れます。
宛先がほかの参加者になっている`SYNCHRONIZE_GAME_OBJECT`・`REQUEST_GAME_OBJECT`・`REQUEST_CATALOG`・`ROLE_REQUEST`・`ROLL_REQUEST`は、読まずにその人へ届けます。

`PeerCursor`の`syncData.role`は、いつもサーバーが決めた役割で上書きします。
送った役割と違っていたら、送り主には直したものを`AUTHORITATIVE_OBJECT`で返します。

## サーバーが送るイベント

`from`が`@authority`の`data`で届きます。

| イベント               | 中身                                  | すること                                                                                                     |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AUTHORITATIVE_OBJECT` | オブジェクトの中身（`ObjectContext`） | 版にかかわらず置き換え、消した印も外す。書く権限の無い変更を戻すときと、サーバーが直したものを渡すときに使う |
| `WITHDRAW_GAME_OBJECT` | `{ identifier }`                      | 消した印を残さずに、手元から外す。書く権限の無い人が作ったものを取り下げさせるときに使う                     |
| `ROLE_REJECTED`        | `{ peerId, role, reason }`            | `ROLE_REQUEST`を断った。理由は[役割を変える](/cloudflare/login#役割を変える)にある                           |

## サーバーで振るダイス

チャットのダイスのコマンドは、サーバーがBCDiceで振ります。
振った人の手元で振らないので、結果を書き換えて送ることはできません。

Axeは、自分で振るときと同じ形で結果の発言（`chat`）を用意し、まだ手元には置かずに、コマンドと一緒にサーバーへ送ります。

```json
{
  "eventName": "ROLL_REQUEST",
  "data": {
    "message": {
      "aliasName": "chat",
      "identifier": "…",
      "majorVersion": 1,
      "minorVersion": 0.5,
      "syncData": { "parentIdentifier": "<タブ>", "…": "…" }
    },
    "command": "2d6+3",
    "gameSystem": "SwordWorld2.5",
    "speaker": "Kai",
    "suffix": " [ゴブリン]"
  }
}
```

| フィールド   | 内容                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `message`    | 用意した結果の発言                                                        |
| `command`    | 振るコマンド。全角を半角に直したもの。先頭に回数（`3 2d6`）を付けてもよい |
| `gameSystem` | ゲームシステムのID。知らないものなら`DiceBot`で振る                       |
| `speaker`    | 発言した人の名前                                                          |
| `suffix`     | 結果の文面の後ろに付けるもの（対象のキャラの名前など）。省いてよい        |

サーバーは振った結果で、発言の次の項目を埋め、新しい発言として全員に配ります（振った人にも届きます）。
`value`は`syncData`の直下、ほかはChatMessageのSyncVarなので`syncData.attributes`に入ります。

| 項目         | 入れるもの                                                           |
| ------------ | -------------------------------------------------------------------- |
| `value`      | 結果の文面（`DiceBot : (1D6) → 4`の形。Axeが自分で振ったときと同じ） |
| `dicebot`    | 出目と成否のJSON                                                     |
| `tag`        | `system`。シークレットダイスなら`system secret`                      |
| `name`       | `<BCDice：名前>`。シークレットダイスなら`<Secret-BCDice：名前>`      |
| `from`       | `System-BCDice`                                                      |
| `originFrom` | 振った人の`userId`                                                   |
| `serverRoll` | `true`                                                               |

- コマンドでなければ、何も配りません。
- 見学者は、見学者も話せるタブでだけ振れます。
- サーバーが振った発言は、あとから`value`と、`attributes`の`dicebot`・`tag`・`name`・`from`・`originFrom`を書き換えられません（ほかの項目は書き換えられる）。書き換えて送ってきたら、元に戻したものを`AUTHORITATIVE_OBJECT`で返します。
- `serverRoll`は、サーバーが振った発言にしか付きません。クライアントが付けて送ってきても外します。Axeはこれを見て、サーバーで振った結果だとわかるように見せられます。
- ダイス表やリソースの操作は、これまでどおりAxeが手元で処理します。
- BCDiceの版は、Axeと揃えます（いまは4.10.0）。

## 見せないもの

見てはいけない人には、届けないか、一部を伏せて届けます。
期待値は`apps/cloudflare/contracts/fixtures/visibility.json`にあります。

| もの                                                                                               | 届けない・伏せる相手                                                         | どうするか                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| カード（`card`）の下の`image/front`・`common/name`・`common/text`・`detail`の下                    | 表が見えない人（裏向き、自分が覗いていない、自分の手札でもない）。GMは見える | 届けない                                                                                                      |
| 秘話（`attributes.to`が空でない`chat`）                                                            | 宛先と送り主（`from`か`originFrom`）のほか。GMも                             | 届けない                                                                                                      |
| シークレット（`attributes.tag`に`secret`がある`chat`）                                             | 送り主とGMのほか                                                             | `value`と、`attributes`の`dicebot`・`stamp`・`attachmentImageIdentifiers`・`editHistory`・`vnEmote`を空にする |
| 持ち主のいるダイス（`dice-symbol`）                                                                | 持ち主とGMのほか                                                             | `attributes.face`を空にする                                                                                   |
| 公開を絞ったメモ（`text-note`の`disclosureMode`が`gm`か`selected`）の`common/title`・`common/text` | 見えない人（GMと持ち主は見える）                                             | 文字を`█`にする（空白はそのまま）                                                                             |
| 同じメモの`detail`の下                                                                             | 同じ                                                                         | 届けない                                                                                                      |
| タブ（`chat-tab`）の発言                                                                           | `plCanView`・`guestCanView`で見てよくない役割（`SystemTab`は誰にでも）       | 届けない                                                                                                      |
| リアクション（`chat-reaction`）                                                                    | その発言が届かない人                                                         | 届けない                                                                                                      |

データ要素は、親をたどった名前の道筋（根のデータ要素の下から、たとえば`image/front`）で見分けます。識別子の形（`front_<カードのID>`）では見分けません。

- 見え方が変わったら（カードをめくる、手札に入れる、秘話の宛先を変える、タブを開く、役割が変わる）、見えるようになった人には`AUTHORITATIVE_OBJECT`で渡し、見えなくなった人には`WITHDRAW_GAME_OBJECT`で外させます。
- カタログ、`REQUEST_GAME_OBJECT`への答え、サーバーで振ったダイスも、同じ決まりで届けます。クライアントのカタログに見えないものがあれば、`WITHDRAW_GAME_OBJECT`を返します。
- 見えないものに書こうとすると、`WITHDRAW_GAME_OBJECT`が返り、何も変わりません。見えないものは消せません。
- 伏せた形で持っているものを書き戻すと、伏せたところは置いてある中身に戻ります（ダイスを動かしても出目は消えない）。
- 消したものの子孫は、送り主から見えなかったものも一緒に消し、持っている人には`DELETE_GAME_OBJECT`を送ります。
- サーバーが差し込んだイベントは、ほかの人の束（`data`）に入ることがあります。誰からのイベントかは、束の`from`ではなく、イベントごとの`sendFrom`で見てください。

## 見学者が書けるもの

見学（`guest`）の人が書けるのは、次のものだけです。

- 自分の`PeerCursor`（書き換えと、消すこと）
- 見学者も話せるタブ（`chat-tab`の`attributes.guestCanSpeak`が`true`）への新しい発言（`chat`）。ダイスの結果のように`from`が本人でないものも書ける
- 自分の発言（`attributes`の`from`か`originFrom`が自分の`userId`）の書き直し

それ以外の`UPDATE_GAME_OBJECT`と`DELETE_GAME_OBJECT`は配らず、見学者の画面で戻させます。

| 書こうとしたもの               | 見学者に返すもの                         |
| ------------------------------ | ---------------------------------------- |
| サーバーが持っているもの       | `AUTHORITATIVE_OBJECT`（サーバーの中身） |
| 消したもの                     | `DELETE_GAME_OBJECT`                     |
| どちらでもない（新しく作った） | `WITHDRAW_GAME_OBJECT`                   |

## 接続を閉じる理由

サーバーは`error`を送ってから、close code `4000`、reasonに同じコードを付けて閉じます。

| コード              | 起きるとき                                                                                  | つなぎ直して直るか |
| ------------------- | ------------------------------------------------------------------------------------------- | :----------------: |
| `protocol-mismatch` | `hello`の`protocolVersion`がサーバーと違う。Axeを読み込み直して更新する                     |                    |
| `room-not-found`    | 部屋が無い（作られていないか、消えた）                                                      |                    |
| `room-full`         | 部屋にいる人が32人に達している                                                              |         ✅         |
| `wrong-password`    | パスワードが違うか、無い                                                                    |                    |
| `hello-required`    | 最初のメッセージが`hello`でない                                                             |                    |
| `bad-message`       | MessagePackとして読めない、展開すると32MiBを超える、封筒の形が違う                          |                    |
| `too-many-messages` | 10秒のあいだに2000を超えるフレームを送った                                                  |         ✅         |
| `replaced`          | 同じピアIDで新しい接続が入った。つなぎ直すと新しい方を追い出すので、つなぎ直さない          |                    |
| `unauthorized`      | `accessToken`が無効か期限切れ、または`userId`がアカウントと違う。トークンを替えてつなぎ直す |         ✅         |

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
