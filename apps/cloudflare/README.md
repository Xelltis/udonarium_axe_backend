# udonarium-axe-backend（Cloudflare版）

Udonarium Axeのサーバー版のWorkerです。2つのものを受け持っています。

- **アセットサーバー**：画像と音声を中身のSHA-256を名前にしてR2に置き、卓の参加者がP2Pの代わりにここから受け取れるようにします。同じ画像は何度上げても1つしか置かれません。SkyWay版の配信にも足せます。
- **部屋のサーバー**：部屋ごとのDurable Objectが、参加者のWebSocketを受けてやりとりを中継し、卓の状態を持ちます。SkyWayもトークン発行サーバーも使わずに遊ぶためのものです。

部屋には、GMとPLはDiscordでログインして入り、ログインしていない人は見学になります。役割はサーバーが決めて守ります。
部屋のサーバーとログインは、サーバー側はできていますが、Axe側の対応はこれからです。
SkyWay版の配信は、これからも残ります。

## エンドポイント

| メソッド | パス                    | 内容                                                     |
| -------- | ----------------------- | -------------------------------------------------------- |
| `HEAD`   | `/v1/assets/:sha256`    | 置かれているかを返す                                     |
| `GET`    | `/v1/assets/:sha256`    | 中身を返す。どのページからでも読める                     |
| `PUT`    | `/v1/assets/:sha256`    | 置く。許可したOriginからのリクエストだけ受ける           |
| `POST`   | `/v1/rooms`             | 部屋を作る                                               |
| `GET`    | `/v1/rooms`             | 部屋の一覧                                               |
| `DELETE` | `/v1/rooms/:roomKey`    | 部屋を削除する（その部屋のGMだけ）                       |
| `GET`    | `/v1/rooms/:roomKey/ws` | 部屋に入る（WebSocket）                                  |
| `GET`    | `/v1/auth/config`       | ログインに使える提供元                                   |
| `GET`    | `/v1/login/discord`     | ログインを始める（ページとして開く）                     |
| `POST`   | `/v1/auth/token`        | ログインのコードやリフレッシュトークンをトークンに替える |
| `POST`   | `/v1/auth/logout`       | ログアウト                                               |
| `GET`    | `/v1/account`           | ログインしている人                                       |
| `DELETE` | `/v1/account`           | アカウントを消す                                         |

`:sha256`は中身のSHA-256を小文字の16進で書いた64文字です。
PUTでは、本文のハッシュがこの名前と合わなければ置きません。

### アップロードの制限

PUTは、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたOriginからしか受けません。
新しく置くPUTは、送信元ごとに1分100件までです。
IPv6は/64ごとにまとめて数えるので、アドレスを替えても増やせません。
すでに置いてあるものへのPUTは数えません。

Originはブラウザ以外からなら好きに書けるので、これは乱用を抑えるための制限で、置ける人を限るものではありません。
置いたものは保持期間を過ぎると消えます。
サーバー版の部屋ができたら、ログインして得たセッショントークンをPUTにも求めます。

### 受け付ける形式

形式は先頭のバイトで判定し、宣言されたContent-Typeは見ません。

| 種類 | 形式                                       | 上限  |
| ---- | ------------------------------------------ | ----- |
| 画像 | PNG・JPEG・GIF・BMP・WebP・AVIF・HEIC・SVG | 2MiB  |
| 音声 | MP3・WAV・Ogg・FLAC・M4A・AAC              | 10MiB |

SVGは中にスクリプトを書けるので、配るときに`Content-Security-Policy`の`sandbox`を付け、開いてもスクリプトが動かないようにします。
このWorkerを置くドメインでは、cookieを使わないでください。
MP4やMOVの動画は、M4Aと同じ入れ物ですが受け付けません。
受け付けなかった画像は、これまでどおりP2Pで配られます。

### キャッシュと保持期間

GETの応答は`Cache-Control: public, max-age=…, immutable`で返します。
`max-age`は7日か、保持期間の残りの短いほうです。
キャッシュに残った版が、バケットから消えたあとまで「ある」と答えないようにするためです。

保持期間（`ASSET_RETENTION_DAYS`、既定は30日）を過ぎたものは`404`を返します。
アップロードした人が次に部屋を読み込んだとき、HEADが`404`になるので上げ直され、保持期間もそこから数え直します。
過ぎたものは、新しく置くついでに少しずつバケットから消すので、ライフサイクル規則は要りません。

同じデータセンターからの2回目以降のGETは、[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)から返し、R2を読みません。
Cache APIは`*.workers.dev`では効かないので、本番はカスタムドメインに置いてください。
R2を読むGETとHEADは、送信元ごとに1分600件までです。
レート制限は、同じアカウントに置いた別のWorkerとは別に数えます。

### エラー

本文は`{"error": "<コード>"}`の形です。

| 状態 | コード                | 起きるとき                                                         |
| ---- | --------------------- | ------------------------------------------------------------------ |
| 400  | `invalid-id`          | 名前が64文字の小文字16進でない、部屋の鍵の形が違う                 |
| 400  | `invalid-request`     | 部屋を作る本文がJSONでない、名前やパスワードの形が違う             |
| 400  | `invalid-grant`       | ログインのコードやリフレッシュトークンが、無効・使用済み・期限切れ |
| 401  | `login-required`      | 部屋を作る・置くのに、アクセストークンが無いか無効                 |
| 400  | `hash-mismatch`       | 本文のハッシュが名前と合わない                                     |
| 403  | `origin-not-allowed`  | PUTか部屋のもののOriginが許可リストにない                          |
| 403  | `not-game-master`     | 部屋を削除しようとしたが、その部屋のGMでない                       |
| 404  | `not-found`           | その名前の中身が置かれていないか、保持期間を過ぎた                 |
| 404  | `room-not-found`      | 部屋が無い（作られていないか、消えた）                             |
| 411  | `length-required`     | PUTに`Content-Length`がない                                        |
| 412  | `precondition-failed` | GETの`If-Match`か`If-Unmodified-Since`に合わない                   |
| 413  | `too-large`           | 種類ごとの上限を超えている                                         |
| 415  | `unsupported-type`    | 受け付ける画像でも音声でもない                                     |
| 426  | `upgrade-required`    | 部屋に入るURLを、WebSocketでなく開いた                             |
| 429  | `rate-limited`        | アップロード、R2の読み出し、部屋を作る・入るのどれかが上限を超えた |
| 451  | `blocked`             | 運営する人が、その名前のものを置かせないようにした                 |
| 500  | `config-invalid`      | 環境変数が足りないか、形が違う                                     |
| 500  | `internal-error`      | それ以外の失敗                                                     |
| 503  | `room-full`           | 部屋が受けるWebSocketの数に達している                              |
| 503  | `login-unavailable`   | ログインの3つが入っていない                                        |

`config-invalid`のときは、足りない設定の名前がWorkerのログに出ます。

### 部屋のサーバー

部屋ごとに1つのDurable Object（`RoomDurableObject`、SQLite）が、参加者のWebSocketを受けます。
サーバーは参加者から見て、全部を持っているもう1人のピア（`@authority`）としてふるまいます。

- カタログの交換はこのピアとだけ行います。入ってきた人が持っている新しいものは取り寄せ、サーバーの方が新しいものは入ってきた人が取りに来ます。
- `UPDATE_GAME_OBJECT`と`DELETE_GAME_OBJECT`は、版を比べて（新しい方を勝たせる）から、ほかの全員に配ります。古い版を送った人には、持っている方を送り返します。消したものは印を残し、生き返らせません。
- 参加者ごとのカーソル（`PeerCursor`）は、その人がいるあいだだけ持ちます。
- 送り主（`sendFrom`）はサーバーが上書きし、送り主には返しません。
- 接続の情報はWebSocketに添え、卓の状態はSQLiteに置くので、Hibernationで眠っても戻ります。書き込みはオブジェクトごとに1秒ぶんまとめ、1MiBを超えるものは行を分けて置きます。
- 最後の1人が抜けて`ROOM_RETENTION_HOURS`（既定24時間）が過ぎると、部屋ごと消します。人がいるあいだは1時間ごとに接続を数え直すので、Workerが落ちて接続が切れたときも、一覧の人数が直り、部屋は消えます。
- 部屋の一覧は、Workerに1つのDurable Object（`LobbyDurableObject`）が持ちます。D1は使わないので、デプロイで作るものは増えません。

部屋を作れるのはログインした人だけで、作った人がGMになります。
ログインして入った人はPL（GMが署名した招待があれば、その役割）、ログインしていない人は見学です。
`PeerCursor`の役割はサーバーが上書きし、見学者が書けるのは自分のカーソルと、見学者も話せるタブへの発言だけです。
裏向きのカードの表、他人宛ての秘話、シークレットダイスの結果など、見てはいけない人に届けてはいけないものは、その人の接続には送りません（伏せて送るものもあります）。
見え方が変わると、`AUTHORITATIVE_OBJECT`で渡すか`WITHDRAW_GAME_OBJECT`で外させます。
チャットのダイスは、サーバーがBCDiceで振ります（`ROLL_REQUEST`）。
部屋のパスワードはPBKDF2のハッシュにして置き、`hello`で受けたものと照らします。
部屋を作る・入るのは、許可したOriginから、送信元ごとに合わせて1分30回までです。
1つの部屋に入れるのは32人、1つの接続から送れるのは10秒に2000フレームまでです。

やりとりの形（封筒、エラーのコード）と、Axeと同じ判定になるかを確かめるフィクスチャは[contracts/](contracts)にあります。

### ログイン

ログインはDiscordの認可コードの流れで、Axeとこのサーバーのあいだは、PKCEで守ります。
Axeは`code_challenge`を付けて`/v1/login/discord`を開き、戻り先のフラグメントで受けた使い捨てのコードを、`code_verifier`と一緒に`POST /v1/auth/token`でトークンに替えます。
アクセストークンは15分のJWT（HS256）、リフレッシュトークンは使うたびに替わります。
アカウントは、ログインした人ごとのDurable Object（`AccountDurableObject`）に置くので、D1は使いません。

Discordのアプリの**Redirects**には、`https://<Workerのドメイン>/v1/login/discord/callback`を入れます。
ログインを置いたWorkerでは、画像と音声を置く（PUT）のにもログインが要ります。

## セットアップ

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Xelltis/udonarium_axe_backend/tree/main/apps/cloudflare)

ボタンから、このディレクトリを自分のGitHubリポジトリとして複製し、Cloudflareのアカウントにデプロイできます。
R2のバケットは最初のデプロイで「<Workerの名前>-assets」が作られるので、自分で作る必要はありません。
同じアカウントに何台置いても、Workerの名前ごとに別のバケットになります。

前もって、アカウントでR2を使い始めておきます。
ダッシュボードの「Storage & databases → R2」で、アカウントに一度だけ申し込みます（無料枠があります）。
まだのアカウントでは、バケットを作れずにデプロイが失敗します。

デプロイの画面では、次のものを尋ねられます。

| 名前                          | 中身                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | アプリを配信しているOrigin。複数あるときはカンマで区切る |
| `ASSET_RETENTION_DAYS`        | 画像と音声を残す日数（既定は30）                         |
| `ROOM_RETENTION_HOURS`        | 最後の1人が抜けてから部屋を消すまでの時間（既定は24）    |
| `DISCORD_CLIENT_ID`           | ログインに使うDiscordのアプリのClient ID                 |
| `DISCORD_CLIENT_SECRET`       | 同じアプリのClient Secret                                |
| `SESSION_SECRET`              | トークンに署名する鍵。32文字以上の乱数                   |

ログインの3つは、そろえて入れるか、どれも入れないかのどちらかにします。
どれも入れなければ、ログインと部屋は使えず、アセットサーバーだけが動きます。

部屋のサーバーのDurable Objectsも、デプロイのときに作られます。

キャッシュを効かせるため、デプロイしたWorkerにはカスタムドメインを付けてください。
アプリ側の`config.json`には、このWorkerのURLを`assets.url`として書きます。

Workerを呼んだ回数そのものは、Workerの中では減らせません。
読み出しを繰り返されるのが心配なら、カスタムドメインのゾーンにWAFのレート制限ルールを足してください。

### wranglerで手元からデプロイする

`npx wrangler login`でログインしてから、次のようにします。
Workerの名前は`--name`で決め、R2のバケットも名前ごとに作られます。

```sh
npm ci
npx wrangler deploy --name my-udonarium-assets \
  --var ACCESS_CONTROL_ALLOW_ORIGIN:https://axe.example.com
```

### mainからの自動デプロイ

このリポジトリでは、mainに入った変更を、CIのCloudflareのジョブが通ったあとにデプロイします（`.github/workflows/ci.yml`の`deploy-cloudflare`）。
出し先は、リポジトリのVariable`CLOUDFLARE_DEPLOY_ENVIRONMENTS`に、GitHubのEnvironmentの名前のJSON配列で書きます（例：`["cloudflare-production", "cloudflare-public"]`）。
書かなければ何もしません。
EnvironmentごとにWorkerが1つで、それぞれに次のSecretを入れておきます。

| 名前                          | 中身                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `WORKER_NAME`                 | Workerの名前。R2のバケットは「<この名前>-assets」になる        |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | アプリを配信しているOrigin。`wrangler.jsonc`の値の代わりに使う |
| `CLOUDFLARE_API_TOKEN`        | デプロイに使うAPIトークン（権限は下を参照）                    |
| `CLOUDFLARE_ACCOUNT_ID`       | CloudflareのアカウントID。リポジトリのSecretに置いても構わない |

`ACCESS_CONTROL_ALLOW_ORIGIN`は、デプロイのたびにWorkerのシークレットとして入れ直します。
値を変えたときは、mainのCIを走らせ直せば入れ替わります。

APIトークンは、mainだけが使えるEnvironmentに置き、権限は次のように絞ります。

| 時期                       | 権限                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Workerを初めてデプロイする | Workers Admin（すべてのWorker）と、Workers R2 Storage Write・Read（バケットを作るため） |
| 2回目から                  | Workers Editor（デプロイするWorkerだけ）                                                |

2回目からは、デプロイ済みのWorkerからバケットの割り当てを引き継ぐので、R2の権限は要りません。

## 開発

```sh
npm ci
npm run dev        # http://localhost:8787 で起動
npm test           # Workersのランタイム（workerd）の中でテストする。カバレッジ100%を要求
npm run lint
npm run typecheck
```

テストは`@cloudflare/vitest-pool-workers`が持つwranglerとworkerdで動きます。
`npm run dev`と`npm run deploy`も同じランタイムで動くよう、`wrangler`はそのwranglerと同じ版に固定しています。
上げるときは、`@cloudflare/vitest-pool-workers`が使う版に合わせてください（CIで確かめます）。
