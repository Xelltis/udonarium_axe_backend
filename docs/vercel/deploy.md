# Vercel版をデプロイする

Deployボタンを使って、Vercel版を自分のVercelアカウントに置くまでの手順です。
SkyWayのトークン発行に使うなら、このまま手順1から進めます。
部屋のサーバー（サーバー版）に使うなら、[部屋のサーバーとして置く](#部屋のサーバーとして置く)に進みます。

## 1. Deployボタンを押す

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

ボタンを押すと、Vercelの「新しいプロジェクト」の画面が開きます。
このリポジトリの`apps/vercel`だけが、あなたのGitHubに新しいリポジトリとして複製されます。

## 2. リポジトリの名前を決める

1. 複製先のGitHubアカウントを選びます。
2. リポジトリの名前を決めます。既定は`my-udonarium-backend-vercel`です。身内用と公開用など、複数置くときは名前を変えます。
3. 非公開（Private）にするかを選びます。どちらでも動きます。

## 3. 環境変数を入れる

次の3つを入れます。

| 名前                          | 入れる値                                                 |
| ----------------------------- | -------------------------------------------------------- |
| `SKYWAY_APP_ID`               | SkyWayのアプリケーションID                               |
| `SKYWAY_SECRET`               | SkyWayのシークレットキー                                 |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | Axeを配信しているOrigin（例：`https://axe.example.com`） |

ほかにも、トークンの有効期間とロビーの数を変えられます。
あとから足すこともできるので、ここでは入れなくて構いません。
詳しくは[設定項目](/vercel/configuration)にあります。

## 4. デプロイする

**Deploy**を押し、ビルドが終わるのを待ちます（1〜2分ほど）。
完了すると、`https://my-udonarium-backend-vercel.vercel.app`のようなURLが出ます。
これがトークン発行サーバーのURLです。

## 5. 動いているか確かめる

ターミナルで次を実行します。
Vercel版は`/v1/`の下でOriginを確かめるので、`Origin`ヘッダーを付けます。

```sh
curl -H "Origin: https://axe.example.com" https://my-udonarium-backend-vercel.vercel.app/v1/status
```

`OK`と表示されれば成功です。

トークンが発行できるかは、次で確かめられます。

```sh
curl -X POST https://my-udonarium-backend-vercel.vercel.app/v1/skyway/tokens \
  -H "Origin: https://axe.example.com" \
  -H "Content-Type: application/json" \
  -d '{"formatVersion":1,"channelName":"test-room","peerId":"test-peer"}'
```

## 6. Axeにつなぐ

Axeの`assets/config.json`の`backend.url`に、手順4のURLを書きます。

```json
{
  "backend": {
    "url": "https://my-udonarium-backend-vercel.vercel.app"
  }
}
```

詳しくは[Axe側の設定](/guide/client-config)を見てください。

## 部屋のサーバーとして置く

部屋のサーバーには、Discordのアプリ、Redis、Vercel Blobのストアが要ります。

### 1. Discordのアプリを作る

[Discord Developer Portal](https://discord.com/developers/applications)でアプリを作り、OAuth2のClient IDとClient Secretを控えます。
**Redirects**には、次のURLを足します。`<デプロイのドメイン>`は、Axeの`backend.url`に書くのと同じドメインです。

```text
https://<デプロイのドメイン>/v1/login/discord/callback
```

ドメインはデプロイしてから決まるので、Redirectsはあとから足しても構いません。
プレビューのデプロイ（`*-git-*.vercel.app`など）はURLが毎回替わるので、そこからはログインできません。本番のURLか、独自ドメインを使います。
くわしくは[ログインと役割](/cloudflare/login#ログインを使えるようにする)を見てください。

### 2. Deployボタンを押す

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=ACCESS_CONTROL_ALLOW_ORIGIN,DISCORD_CLIENT_ID,DISCORD_CLIENT_SECRET,SESSION_SECRET&project-name=my-udonarium-rooms-vercel&repository-name=my-udonarium-rooms-vercel)

次の4つを入れます。

| 名前                          | 入れる値                                                            |
| ----------------------------- | ------------------------------------------------------------------- |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | Axeを配信しているOrigin（例：`https://axe.example.com`）。`*`は不可 |
| `DISCORD_CLIENT_ID`           | 手順1のClient ID                                                    |
| `DISCORD_CLIENT_SECRET`       | 手順1のClient Secret                                                |
| `SESSION_SECRET`              | 32文字以上の乱数（例：`openssl rand -base64 48`で作ったもの）       |

この時点では、まだRedisとBlobが無いので、部屋のサーバーの経路は`500 config-invalid`を返します。

### 3. RedisとBlobをつなぐ

Vercelのプロジェクトの「Storage」から、次の2つを作ってプロジェクトにつなぎます。

1. **Redis**：Vercel MarketplaceのRedis（Upstashなど）。つなぐと`REDIS_URL`か`KV_URL`が入ります。リージョンは東京に近いところを選びます。
2. **Blob**：アクセスを**Private**にしたストア。つなぐと、Blobのストアを読み書きする設定が入ります。

つないだら、「Deployments」から最新のデプロイを選び、**Redeploy**を押します。

### 4. 動いているか確かめる

```sh
curl -H "Origin: https://axe.example.com" https://my-udonarium-rooms-vercel.vercel.app/v1/auth/config
```

`{"providers":["discord"]}`と返れば、ログインが使えます。
`{"error":"config-invalid"}`なら、Functionの「Logs」に足りない設定の名前が出ています。

### 5. Axeにつなぐ

Axeの`assets/config.json`で、`transport`を`server`にし、`backend.url`にデプロイのURLを書きます。

```json
{
  "transport": "server",
  "backend": {
    "url": "https://my-udonarium-rooms-vercel.vercel.app"
  }
}
```

詳しくは[Axe側の設定](/guide/client-config#サーバー版で配信するとき)を見てください。

### 掃除の鍵

時間が過ぎた部屋を消す掃除は、`vercel.json`の`crons`で1日1回呼ばれます（`/internal/sweep`）。
環境変数`CRON_SECRET`に乱数を入れておくと、Vercel Cronのほかからは呼べなくなります。

### SkyWayのトークン発行と一緒に置く

同じデプロイに、SkyWayの`SKYWAY_APP_ID`と`SKYWAY_SECRET`も入れれば、トークン発行も受け持ちます。
別々のデプロイに分けても構いません。

## 独自ドメインで公開する

`*.vercel.app`のURLのままでも使えます。
自分のドメイン（例：`backend.example.com`）で公開したいときは、Vercelのプロジェクトの「Settings → Domains」から足します。
足したら、Axeの`backend.url`も新しいURLに書き換えます。

## 更新するとき

Deployボタンで作ったリポジトリは、このリポジトリとは別のものです。
新しい版を取り込むには、次のどちらかをします。

- このリポジトリの`apps/vercel`の変更を、自分のリポジトリに手で取り込む
- もう一度Deployボタンで新しいプロジェクトを作り、環境変数を入れ直して、Axeの`backend.url`を差し替える
