# Cloudflare版の設定項目

Cloudflare版の設定は、`apps/cloudflare/wrangler.jsonc`に書きます。
Deployボタンで置いた場合は、複製した自分のリポジトリの`wrangler.jsonc`です。

## 変数

| 名前                          | 既定値                  | 内容                                                                      |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | `http://localhost:4200` | アップロードと部屋を受けるOrigin。カンマ区切りで複数書ける。`*`ならすべて |
| `ASSET_RETENTION_DAYS`        | `30`                    | 置いたものを残す日数（1以上の整数）                                       |
| `ROOM_RETENTION_HOURS`        | `24`                    | 最後の1人が抜けてから部屋を消すまでの時間（1以上の整数）                  |

## シークレット

ログインと部屋を使うときに、Workerのシークレットとして入れます。
`wrangler.jsonc`には書きません（手元では`.dev.vars`に書きます。ひな形は`.dev.vars.example`）。

| 名前                    | 内容                                                 |
| ----------------------- | ---------------------------------------------------- |
| `DISCORD_CLIENT_ID`     | ログインに使うDiscordのアプリのClient ID             |
| `DISCORD_CLIENT_SECRET` | 同じアプリのClient Secret                            |
| `SESSION_SECRET`        | アクセストークンと招待に署名する鍵。32文字以上の乱数 |

3つは、そろえて入れるか、どれも入れないかのどちらかにします。
どれも入れなければ、ログインと部屋は使えず、アセットサーバーだけが動きます。
くわしくは[ログインと役割](/cloudflare/login#ログインを使えるようにする)を見てください。

どれかが無い、または形が違うと、すべてのリクエストに`500 config-invalid`を返し、足りない設定の名前をWorkerのログに出します。

### `ACCESS_CONTROL_ALLOW_ORIGIN`

Axeを配信しているページのOriginを書きます。
これが効くのは、アップロード（PUT）と、部屋のもの（作る・一覧・入る）です。
画像と音声の読み出し（GETとHEAD）は、どのページからでも受けます。

- スキーム（`https://`）・ホスト名・ポートがすべて一致したときだけ通します。パスや末尾の`/`の違いは見ません。
- 既定値の`http://localhost:4200`は、Axeを手元で開発するときのものです。本番では必ず書き換えてください。

### `ASSET_RETENTION_DAYS`

置いてからこの日数を過ぎた画像と音声は、`404`を返し、少しずつバケットから消します。
使われている画像は、GMが次に部屋を読み込んだときに上げ直され、そこから数え直します。
くわしくは[運用と料金](/cloudflare/operations#保持期間と掃除)を見てください。

### `ROOM_RETENTION_HOURS`

部屋から最後の1人が抜けて、この時間が過ぎると、部屋を一覧から外し、卓の状態をすべて消します。
その前に誰かが入れば、消す予定は取り消します。
作ったまま誰も入らなかった部屋も、同じ時間で消えます。

## バインディング

Workerが使うCloudflareの資源です。

| 名前             | 種類             | 内容                                                                                                         |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `ASSETS`         | R2バケット       | 画像と音声の置き場。名前は書かず、最初のデプロイで「<Workerの名前>-assets」が作られる                        |
| `ROOMS`          | Durable Object   | 部屋ごとに1つ（`RoomDurableObject`）。名前は部屋の鍵                                                         |
| `LOBBY`          | Durable Object   | 部屋の一覧（`LobbyDurableObject`）。Workerに1つ                                                              |
| `ACCOUNTS`       | Durable Object   | ログインした人ごとに1つ（`AccountDurableObject`）。名前は`discord:<ID>`                                      |
| `UPLOAD_LIMITER` | レート制限       | 新しく置くPUTを、送信元ごとに1分100件まで                                                                    |
| `READ_LIMITER`   | レート制限       | R2を読むGETとHEADを、送信元ごとに1分600件まで                                                                |
| `ROOM_LIMITER`   | レート制限       | 部屋を作る・部屋に入るのを、送信元ごとに合わせて1分30回まで                                                  |
| `AUTH_LIMITER`   | レート制限       | Discordから戻るのとトークンを発行するのを、送信元ごとに合わせて1分60回まで                                   |
| `METRICS`        | Analytics Engine | 部屋で起きたことを書くデータセット`udonarium_axe_rooms`（→ [部屋の記録](/cloudflare/operations#部屋の記録)） |

Durable Objectsは、SQLiteに状態を置く種類です。
`wrangler.jsonc`の`migrations`に書いてあるので、最初のデプロイで作られます。
クラスの名前を変えたり消したりするときは、`migrations`に新しい`tag`を足します（今ある`tag`は書き換えません）。

部屋のフレームのgzip、パスワードのハッシュ、トークンの署名に`node:zlib`と`node:crypto`を使うので、`compatibility_flags`に`nodejs_compat`を入れています。

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
- **すでに置いてあるもの**へのPUTは数えません。部屋を読み込むと、上がっている画像もまとめて確かめられるためです。
- **データセンターのキャッシュ**から返したGETは数えません。
- Cloudflareのレート制限は、データセンターごとに数えます。
- `namespace_id`は同じアカウントのWorkerで共有されますが、Cloudflare版は数えるときの鍵に受けたホスト名を付けるので、同じアカウントに置いた別のWorkerとは混ざりません。

## 本番の値をCIから入れるとき

このリポジトリのCIからデプロイするときは、`ACCESS_CONTROL_ALLOW_ORIGIN`をGitHubのSecretから入れ、Workerのシークレットとして置きます。
`wrangler.jsonc`に書いた手元用の値は、同じ名前のシークレットで置き換わります。
くわしくは[mainからの自動デプロイ](/cloudflare/auto-deploy)を見てください。
