# サーバー版の設定項目

部屋のサーバー（Cloudflare版とVercel版）の設定を説明します。
はじめに両方に共通する項目を、そのあとに置き場所ごとの項目と、値の変えかたを書きます。

## 共通の項目

| 名前                          | 必須 | 既定値 | 内容                                                                                                  |
| ----------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------------------- |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | ○    | —      | 受けるAxeのOrigin。カンマ区切りで複数書ける                                                           |
| `DISCORD_CLIENT_ID`           | ※    | —      | ログインに使うDiscordのアプリのClient ID（→ [Discordのアプリを作る](/server/discord)）                |
| `DISCORD_CLIENT_SECRET`       | ※    | —      | 同じアプリのClient Secret                                                                             |
| `SESSION_SECRET`              | ※    | —      | アクセストークン、招待、部屋のアセットのトークンに署名する鍵。32文字以上の乱数                        |
| `ROOM_RETENTION_HOURS`        |      | `24`   | 最後の1人が抜けてから部屋を消すまでの時間（1以上の整数）                                              |
| `ROOM_STORAGE_LIMIT_MB`       |      | —      | 1つの部屋に置ける画像と音声の合計（MB）。入れなければ、合計の上限は無い                               |
| `ADMIN_DISCORD_IDS`           |      | —      | 管理画面（`/admin`）に入れる運営する人のDiscordのユーザーID。カンマ区切り。入れなければ管理画面は無い |
| `ADMIN_PASSKEY_RESET`         |      | —      | パスキーをすべて失くした運営する人のDiscordのユーザーID。入れたあいだだけ、新しいパスキーを登録できる |
| `ADMIN_WEBHOOK_URL`           |      | —      | 運営する人への知らせを送るDiscordのWebhookのURL。入れなければ知らせは送らない                         |
| `ADMIN_STORAGE_ALERT_GB`      |      | —      | 画像と音声の置き場所がこの量（GB）を超えたら知らせる。入れなければ置き場所を数えない                  |

### `ACCESS_CONTROL_ALLOW_ORIGIN`

Axeを配信しているページのOriginを書きます（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）。
部屋のもの（作る・一覧・入る・削除）、部屋のアセット、ログインとアカウントは、ここに書いたOriginのページからしか受けません。
Discordでログインしたあとに戻る先も、ここに書いたOriginのページだけです。

- スキーム（`https://`）・ホスト名・ポートがすべて一致したときだけ通します。パスや末尾の`/`の違いは見ません。
- `*`と書くと、どのOriginからも受けます。ただし`*`は、ログインのあとに戻る先には数えません。`*`だけにすると、だれもログインできず、部屋も作れません。AxeのOriginを、名前で書いてください。

### ログインの3つ

`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`は、そろえて入れるか、どれも入れないかのどちらかにします。

- **3つとも入れる**：ログインと部屋が使えます。ふつうはこれです。
- **どれも入れない**：正しい設定ですが、ログインも部屋も使えません。部屋を作ろうとすると`503 login-unavailable`を返すので、部屋の一覧は空のままです。
- **一部だけ入れる**（`SESSION_SECRET`が32文字より短いときも）：設定の誤りとして、部屋のサーバーのすべてのリクエストに`500 config-invalid`を返します。

部屋を作ったあとで3つを外すと、残っている部屋は、アクセストークン、招待、部屋のアセットのトークンを一切受けなくなります。
部屋には見学としてだけ入れます。

### `SESSION_SECRET`を替えると

`SESSION_SECRET`を替えると、それまでに出したアクセストークン、招待、部屋のアセットのトークンは、すぐにすべて使えなくなります。

- ログインしている人は、ログインし直さずに済みます。リフレッシュトークンは`SESSION_SECRET`とは別に置いているので、Axeが新しいアクセストークンに替えます。
- 招待は、作り直します。前の招待で初めて入った人はPLとして覚えられるので、役割はGMが部屋で変えます。

漏れたかもしれないときのほかは、替えなくて構いません。

### `ADMIN_DISCORD_IDS`

運営する人の管理画面に入れる人の、DiscordのユーザーIDです（→ [管理画面とBAN](/operate/admin)）。
入る人は、このアカウントでDiscordにログインしたうえで、端末のパスキーで確かめます。
DiscordのアプリのRedirectsに、`/admin/login/callback`も足してください（→ [使えるようにする](/operate/admin#使えるようにする)）。
数字でないものが入っていると、設定の誤りとして、部屋のサーバーのすべてのリクエストに`500 config-invalid`を返します。

### `ADMIN_PASSKEY_RESET`

すべての端末のパスキーを失くした運営する人の、DiscordのユーザーIDです（→ [端末を失くしたとき](/operate/admin#端末を失くしたとき)）。
新しいパスキーを登録したら、外してください。

### `ADMIN_WEBHOOK_URL`

回数の上限を超えた送信元や、管理画面へのログインがあったときに、知らせを送るDiscordのWebhookのURLです（→ [Discordで知らせを受ける](/operate/admin#discordで知らせを受ける)）。
`https://`で始まらないと、設定の誤りとして、部屋のサーバーのすべてのリクエストに`500 config-invalid`を返します。

### `ROOM_STORAGE_LIMIT_MB`

1つの部屋に置ける画像と音声の合計を、MB（100万バイト）の整数で書きます（例：`500`）。
置こうとしたものを足すとこれを超えるときは、`413 room-storage-full`で断ります（→ [部屋のサーバーのAPI](/reference/server-api#エラー)）。
アカウントや回線を替えながら1つの部屋に置き続ける使われかたで、置き場所の費用が積み上がるのを抑えます。
1つ1つの画像と音声の大きさの上限（画像2MiB、音声10MiB）とは別にかかります。

- 入れたときは、置くたびにその部屋の画像と音声の一覧を読んで合計します。Cloudflare版ではR2の一覧を読む回数（Class A）が、置くたびに1回ほど増えます。
- すでに上限を超えている部屋の画像と音声は消しません。新しく置くものだけを断ります。
- 0より大きい整数でないと、設定の誤りとして、部屋のサーバーのすべてのリクエストに`500 config-invalid`を返します。

### `ADMIN_STORAGE_ALERT_GB`

部屋に置かれた画像と音声の合計が、この量を超えたら知らせます（→ [Discordで知らせを受ける](/operate/admin#discordで知らせを受ける)）。
GB（10億バイト）で書き、`0.5`のように小数も書けます。
置き場所の無料枠に合わせるなら、Cloudflare版のR2は`10`です。
入れたときだけ、1日1回、日本時間の3時ごろに置き場所を数えます。
0より大きい数でないと、設定の誤りとして、部屋のサーバーのすべてのリクエストに`500 config-invalid`を返します。

### `ROOM_RETENTION_HOURS`

部屋から最後の1人が抜けて、この時間が過ぎると、部屋とその画像と音声を消します（→ [部屋が消えるとき](/server/#部屋が消えるとき)）。
Cloudflare版の既定値の`24`は、`wrangler.jsonc`の`vars`に書いてあります。この行を消すと、`/v1/`の下がすべて`500 config-invalid`になるので、変えるときも消さずに値だけを書き換えます。

## Cloudflare版

### 値の置き場所

Cloudflare版の設定は、2つの場所に分かれています。

| 設定                                                                                                                                                                               | 置き場所                 | 変えかた                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| `ACCESS_CONTROL_ALLOW_ORIGIN`、`ROOM_RETENTION_HOURS`                                                                                                                              | `wrangler.jsonc`の`vars` | 複製したリポジトリの`wrangler.jsonc`を書き換える |
| `DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`、`ADMIN_DISCORD_IDS`、`ADMIN_PASSKEY_RESET`、`ADMIN_WEBHOOK_URL`、`ADMIN_STORAGE_ALERT_GB`、`ROOM_STORAGE_LIMIT_MB` | Workerのシークレット     | Cloudflareのダッシュボードで書き換える           |

`wrangler.jsonc`に書いた値は、デプロイのたびにWorkerの設定を上書きします。
Deployボタンで置いたときは、複製したリポジトリに変更が入るたびにデプロイし直すので、`ACCESS_CONTROL_ALLOW_ORIGIN`は`wrangler.jsonc`の側で書き換えます（→ [Cloudflareに置く](/server/cloudflare#_8-originの設定を確かめる)）。
`wrangler.jsonc`の既定の`http://localhost:4200`は、Axeを手元で開発するときのものです。

シークレットを変えるときは、次のようにします。

1. ダッシュボードの**Workers & Pages**からWorkerを開き、**Settings**の**Variables and Secrets**を開きます。
2. 変えたいシークレットの**Edit**を押し、新しい値を入れます。足すときは**Add**を押し、種類を**Secret**にして、名前と値を入れます。
3. **Deploy**を押します。押すまで、変更は反映されません。

シークレットの値は、保存したあとは画面で見られません。
デプロイし直しても消えません。

このリポジトリのCIからデプロイするときは、`ACCESS_CONTROL_ALLOW_ORIGIN`もGitHubのSecretから入れ、同じ名前のWorkerのシークレットで`wrangler.jsonc`の値を置き換えます（→ [自分のリポジトリから自動でデプロイする](/operate/auto-deploy)）。

### バインディング

Workerが使うCloudflareの資源です。
`wrangler.jsonc`に書いてあり、最初のデプロイで作られます。

| 名前             | 種類             | 内容                                                                                                     |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| `ASSETS`         | R2バケット       | 部屋ごとの画像と音声の置き場。名前は書かず、最初のデプロイで「<Workerの名前>-assets」が作られる          |
| `ROOMS`          | Durable Object   | 部屋ごとに1つ（`RoomDurableObject`）。名前は部屋の鍵                                                     |
| `LOBBY`          | Durable Object   | 部屋の一覧（`LobbyDurableObject`）。Workerに1つ                                                          |
| `ACCOUNTS`       | Durable Object   | ログインした人ごとに1つ（`AccountDurableObject`）。名前は`discord:<ID>`                                  |
| `MODERATION`     | Durable Object   | 運営する人のBANと記録（`ModerationDurableObject`）。Workerに1つ（→ [管理画面とBAN](/operate/admin)）     |
| `UPLOAD_LIMITER` | レート制限       | 新しく置くPUTを、送信元ごとに1分100件まで                                                                |
| `READ_LIMITER`   | レート制限       | R2を読むGETとHEAD、部屋の一覧、鍵で1つ引く部屋、部屋のアセットの一覧を、送信元ごとに合わせて1分600件まで |
| `ROOM_LIMITER`   | レート制限       | 部屋を作る・削除する・部屋に入るのを、送信元ごとに合わせて1分30回まで                                    |
| `AUTH_LIMITER`   | レート制限       | Discordから戻るのと、トークンの発行・更新、ログアウトを、送信元ごとに合わせて1分60回まで                 |
| `METRICS`        | Analytics Engine | 部屋で起きたことを書くデータセット`udonarium_axe_rooms`（→ [部屋の記録](/operate/#部屋の記録)）          |

- Durable Objectsは、SQLiteに状態を置く種類です。クラスの名前を変えたり消したりするときは、`migrations`に新しい`tag`を足します（今ある`tag`は書き換えません）。
- 部屋のフレームのgzip、パスワードのハッシュ、トークンの署名に`node:zlib`と`node:crypto`を使うので、`compatibility_flags`に`nodejs_compat`を入れています。

### レート制限を変える

`wrangler.jsonc`の`ratelimits`の`simple.limit`を書き換えます。
`period`（数える期間の秒数）は、Cloudflareの決まりで`10`か`60`しか選べません。

```jsonc
{
  "name": "UPLOAD_LIMITER",
  "namespace_id": "1001",
  "simple": { "limit": 100, "period": 60 },
}
```

- **送信元**は、IPv4ならアドレス、IPv6なら先頭の/64で数えます。IPv6の利用者は/64を丸ごと持っていることが多く、アドレスを替えるだけで別人として数えられるのを防ぐためです。
- **すでに置いてあるもの**へのPUTは数えません。部屋に入ったAxeが、手元の画像と音声をまとめて確かめに来るためです。
- **データセンターのキャッシュ**から返したGETとHEADは数えません。
- Cloudflareのレート制限は、データセンターごとに数えます。
- `namespace_id`は同じアカウントのWorkerで共有されますが、数えるときの鍵に受けたホスト名を付けるので、同じアカウントに置いた別のWorkerとは混ざりません。

### 手元で動かす

```sh
cd apps/cloudflare
npm ci
cp .dev.vars.example .dev.vars   # ログインの3つを書く
npm run dev                      # http://localhost:8787
```

管理画面も試すときは、`.dev.vars`に`ADMIN_DISCORD_IDS`（自分のDiscordのユーザーID）も書き、DiscordのアプリのRedirectsに`http://localhost:8787/admin/login/callback`を足してから、`http://localhost:8787/admin`を開きます（→ [管理画面とBAN](/operate/admin)）。
`.dev.vars`は、Gitに入らないようにしてあります。

## Vercel版

### 項目

共通の項目に加えて、次のものを読みます。
Vercelのプロジェクトの**Environment Variables**で足したり変えたりします。

| 名前                    | 必須 | 既定値 | 内容                                                                                               |
| ----------------------- | :--: | ------ | -------------------------------------------------------------------------------------------------- |
| `REDIS_URL`             |  ○   | —      | 部屋・一覧・アカウントを置くRedis。無ければ`KV_URL`を読む（Vercel MarketplaceのRedisが入れる名前） |
| `BLOB_STORE_ID`         |  ※   | —      | 部屋の画像と音声を置くVercel Blobのストア（private）のID。Vercelの上では、これで読み書きする       |
| `BLOB_READ_WRITE_TOKEN` |  ※   | —      | 同じストアの鍵。Vercelの外で動かすときは、こちらを入れる                                           |
| `ROOM_SOCKET_SECONDS`   |      | `280`  | 部屋のWebSocketを、部屋のサーバーから閉じてつなぎ直してもらうまでの秒数（60以上）                  |
| `REDIS_KEY_PREFIX`      |      | `axe:` | Redisのキーの頭。1つのRedisを、別のデプロイと分けて使うときに替える                                |
| `CRON_SECRET`           |      | —      | 掃除（`/internal/sweep`）を呼べる鍵。入れると、Vercel Cronのほかからは呼べなくなる。入れないときは、掃除は12時間に1回まで |
| `BLOB_LOCAL_DIR`        |      | —      | 手元で試すときに、画像と音声をこのディレクトリに置く。Vercelの上では使えない                       |

- ※のBlobの2つは、どちらかがあれば足ります。ストアをプロジェクトにつなぐと、Vercelが`BLOB_STORE_ID`を入れます。
- ログインの3つを入れたら、RedisとBlobのストアも要ります。どれかが無い、または形が違うと、部屋のサーバーのすべてのリクエストに`500 config-invalid`を返し、足りない設定の名前をFunctionのログに出します。

### `ROOM_SOCKET_SECONDS`

Vercelは、Functionの最大実行時間（無料のプランは300秒）でWebSocketを切ります。
そうなる前に、部屋のサーバーが自分から閉じて、Axeにすぐつなぎ直してもらいます（close code `1012`、reason `rotate`）。
席は15秒のあいだ残しておくので、ほかの人には、出たことも入ったことも見えません。
有料のプランで`vercel.json`の`maxDuration`を延ばしたときは、これも合わせて延ばせます（`maxDuration`より20秒ほど短くします）。

### 値を変える

Vercelでは、環境変数を変えても、いま動いているデプロイには反映されません。
変えたあとは、**Deployments**から最新のデプロイを選び、**Redeploy**を押します（→ [Vercelに置く](/server/vercel#_7-デプロイし直す)）。

### 手元で動かす

部屋のサーバーは、`vercel dev`ではWebSocketが通らないことがあるので、Vercelの上と同じNodeのサーバーを立てます。
Redisは`compose.yml`で立てられます。

```sh
cd apps/vercel
npm ci
docker compose up -d redis
npm run serve   # .env.local を読んで http://localhost:3000 で待つ（PORT で変えられる）
```

`.env.local`には、たとえば次のように書きます。

```sh
ACCESS_CONTROL_ALLOW_ORIGIN=http://localhost:4200
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
SESSION_SECRET=...
ADMIN_DISCORD_IDS=...
REDIS_URL=redis://localhost:6379
BLOB_LOCAL_DIR=.blob
```

`ADMIN_DISCORD_IDS`を書き、DiscordのアプリのRedirectsに`http://localhost:3000/admin/login/callback`を足せば、`http://localhost:3000/admin`で管理画面を開けます。

`BLOB_LOCAL_DIR`に置くときは、1回の`PUT`で種類ごとの上限まで置けます（Blobへ直接上げる流れは使いません）。
`.env`と`.env.local`は、Gitに入らないようにしてあります。
