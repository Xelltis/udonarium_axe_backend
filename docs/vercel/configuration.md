# Vercel版の設定項目

Vercel版は、Vercelのプロジェクトに設定した環境変数を読みます。
環境変数は、Vercelのプロジェクトの「Settings → Environment Variables」で足したり変えたりできます。

SkyWayのトークン発行と部屋のサーバーは、別々に設定を読みます。
片方だけを使うなら、もう片方の項目は要りません。

## 両方に要るもの

| 名前                          | 必須 | 内容                                                                                              |
| ----------------------------- | :--: | ------------------------------------------------------------------------------------------------- |
| `ACCESS_CONTROL_ALLOW_ORIGIN` |  ✅  | 受けるOrigin。カンマ区切りで複数書ける。`*`ならすべて（ただし部屋のサーバーのログインは通らない） |

### `ACCESS_CONTROL_ALLOW_ORIGIN`

Axeを配信しているページのOriginを書きます。

```text
https://axe.example.com
https://axe.example.com,https://www.axe.example.com
```

- スキーム（`https://`）・ホスト名・ポートがすべて一致したときだけ通します。パスや末尾の`/`の違いは見ません。
- 空にすると、どのOriginも通しません。
- `*`と書くと、すべてのOriginを許可します。試すときだけにしてください。部屋のサーバーでは、`*`はDiscordから戻る先に数えないので、だれもログインできません。

## SkyWayのトークン発行

| 名前                          | 必須 | 既定値  | 内容                                                                  |
| ----------------------------- | :--: | ------- | --------------------------------------------------------------------- |
| `SKYWAY_APP_ID`               |  ✅  | —       | SkyWayのアプリケーションID                                            |
| `SKYWAY_SECRET`               |  ✅  | —       | SkyWayのシークレットキー。トークンの署名に使う                        |
| `SKYWAY_UDONARIUM_LOBBY_SIZE` |      | `3`     | ロビーの数（1以上の整数）。[トークン発行のしくみ](/token/#ロビーの数) |
| `SKYWAY_TOKEN_TTL_SECONDS`    |      | `86400` | 発行するトークンの有効期間（秒）。`60`（1分）〜`604800`（7日）        |

部屋のサーバーだけを使うなら、SkyWayの項目は要りません。
そのときは、SkyWayの経路（`/v1/status`、`/v1/skyway/*`、`/v1/skyway2023/*`）が`CONFIG_INVALID`を返します。

### `SKYWAY_TOKEN_TTL_SECONDS`

トークンの有効期間です。
Axeは部屋に入るときにトークンを受け取り、そのあいだSkyWayにつながり続けます。
既定の24時間で困ることはほとんどありません。
短くすると、漏れたトークンが使える時間を縮められます。

範囲の外の値や、数字でない値を入れると、SkyWayの経路のすべてのリクエストに`CONFIG_INVALID`を返します。

## 部屋のサーバー

| 名前                    | 必須 | 既定値 | 内容                                                                                                      |
| ----------------------- | :--: | ------ | --------------------------------------------------------------------------------------------------------- |
| `DISCORD_CLIENT_ID`     |  ✅  | —      | ログインに使うDiscordのアプリのClient ID                                                                  |
| `DISCORD_CLIENT_SECRET` |  ✅  | —      | 同じアプリのClient Secret                                                                                 |
| `SESSION_SECRET`        |  ✅  | —      | アクセストークン、招待、部屋のアセットのトークンに署名する鍵。32文字以上の乱数                            |
| `REDIS_URL`             |  ✅  | —      | 部屋・一覧・アカウントを置くRedis。無ければ`KV_URL`を読む（Vercel MarketplaceのRedisが入れる名前）        |
| `BLOB_STORE_ID`         |  ※   | —      | 部屋の画像と音声を置くVercel Blobのストア（private）のID。Vercelの上では、これとOIDCで読み書きする        |
| `BLOB_READ_WRITE_TOKEN` |  ※   | —      | 同じストアの鍵。Vercelの外で動かすときは、こちらを入れる                                                  |
| `ROOM_RETENTION_HOURS`  |      | `24`   | 最後の1人が抜けてから部屋を消すまでの時間（1以上の整数）                                                  |
| `ROOM_SOCKET_SECONDS`   |      | `280`  | 部屋のWebSocketを、こちらから閉じてつなぎ直してもらうまでの秒数（60以上）。Functionの最大実行時間より短く |
| `REDIS_KEY_PREFIX`      |      | `axe:` | Redisのキーの頭。1つのRedisを、別のデプロイと分けて使うときに替える                                       |
| `CRON_SECRET`           |      | —      | 掃除（`/internal/sweep`）を呼べる鍵。入れると、Vercel Cronだけが呼べる                                    |
| `BLOB_LOCAL_DIR`        |      | —      | 手元で試すときに、画像と音声をこのディレクトリに置く。Vercelの上では使えない                              |

ログインの3つ（`DISCORD_CLIENT_ID`・`DISCORD_CLIENT_SECRET`・`SESSION_SECRET`）は、そろえて入れるか、どれも入れないかのどちらかにします。
どれも入れなければ、ログインも部屋も使えません（部屋の一覧は空で、部屋を作ると`503 login-unavailable`）。
ログインを入れたら、RedisとBlobのストアも要ります。※のBlobの2つは、どちらかがあれば足ります（ストアをプロジェクトにつなぐと、Vercelが入れます）。
どれかが無い、または形が違うと、部屋のサーバーの経路のすべてのリクエストに`500 config-invalid`を返し、足りない設定の名前をFunctionのログに出します。
くわしくは[ログインと役割](/cloudflare/login#ログインを使えるようにする)を見てください。Cloudflare版と同じです。

### `ROOM_SOCKET_SECONDS`

Vercelは、Functionの最大実行時間（無料プランは300秒）でWebSocketを切ります。
そうなる前に、部屋のサーバーが自分から閉じて、Axeにすぐつなぎ直してもらいます（close code `1012`、reason `rotate`）。
席は15秒のあいだ残しておくので、ほかの人には、出たことも入ったことも見えません。
有料のプランで`vercel.json`の`maxDuration`を延ばしたときは、これも合わせて延ばせます（`maxDuration`より20秒ほど短く）。

### `ROOM_RETENTION_HOURS`

部屋から最後の1人が抜けて、この時間が過ぎると、部屋を一覧から外し、卓の状態と部屋のアセットをすべて消します。
その前に誰かが入れば、消す予定は取り消します。
作ったまま誰も入らなかった部屋も、同じ時間で消えます。

消すのは、部屋の一覧・作る・入るのついでと、1日1回のVercel Cronです。
消すのが遅れても、時間を過ぎた部屋は一覧に出ず、入ることもできません。

## 変えた値を効かせる

Vercelでは、環境変数を変えても、すでに動いているデプロイには反映されません。
変えたあとは、「Deployments」から最新のデプロイを選び、**Redeploy**を押してください。

## 手元で動かすとき

SkyWayのトークン発行だけなら、Vercelに設定した環境変数を取ってきて、`vercel dev`で動かせます。

```sh
cd apps/vercel
npm ci
npm run env     # vercel env pull で .env を作る
npm start       # vercel dev（http://localhost:3000）
```

部屋のサーバーは、`vercel dev`ではWebSocketが通らないことがあるので、Vercelの上と同じNodeのサーバーを立てます。
Redisは`compose.yml`で立てられます。

```sh
cd apps/vercel
docker compose up -d redis
npm run serve   # .env.local を読んで http://localhost:3000 で待つ（PORT で変えられる）
```

`.env.local`には、たとえば次のように書きます。

```sh
ACCESS_CONTROL_ALLOW_ORIGIN=http://localhost:4200
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
SESSION_SECRET=...
REDIS_URL=redis://localhost:6379
BLOB_LOCAL_DIR=.blob
```

`BLOB_LOCAL_DIR`に置くときは、1回の`PUT`で種類ごとの上限まで置けます（置き場所へ直接上げる流れは使いません）。
`.env`と`.env.local`はGitに入らないようにしてあります。
