# Vercelに置く（サーバー版）

サーバー版のAxeで遊ぶための部屋のサーバーを、Vercelに置く手順です。
Cloudflare版と同じ部屋のサーバーが、VercelとRedisとVercel Blobの上で動きます。
かかる時間は、アカウント作りを含めて1時間ほどです。

どちらにするか迷ったら、長く安定して置けるCloudflare版をすすめます（→ [どれを置くか](/guide/choose#サーバー版-cloudflare版かvercel版か)）。
Cloudflare版との違いは、次のとおりです。

| 項目                   | Cloudflare版                                   | Vercel版                                                                                                 |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 部屋の状態             | 部屋ごとのDurable Object                       | Redis。部屋のWebSocketを受けたインスタンスの1つが部屋を受け持ち、ほかのインスタンスはそこへ中継する      |
| 部屋のアセット         | R2                                             | Vercel Blob（private）                                                                                   |
| WebSocketの長さ        | 切れない                                       | Functionの最大実行時間（無料のプランは300秒）まで。その前に部屋のサーバーが閉じて、Axeが静かにつなぎ直す |
| 1回のアップロード      | 種類ごとの上限（画像2MiB、音声10MiB）まで      | 4,000,000バイトまで。それより大きい音声は、AxeがBlobへ直接上げる                                         |
| 時間が過ぎた部屋を消す | 部屋ごとのアラーム                             | 一覧・作る・入るのついでと、1日1回のVercel Cron                                                          |
| 画像と音声のキャッシュ | データセンターに置く（カスタムドメインのとき） | 無い                                                                                                     |

つなぎ直しのあいだも、ほかの人には、出たことも入ったことも見えません。
料金の目安は[料金と上限](/operate/costs#vercel版)にあります。

::: warning VercelのWebSocketはベータです
部屋のサーバーは、VercelのWebSocketを使います。
VercelのWebSocketは、2026年10月の時点でベータです。
:::

::: info Vercelの画面は英語です
Vercelの画面は英語だけです。
このページでは、ボタンやメニューの名前を画面の表示のまま英語で書きます。
:::

## 0. 用意するもの

- GitHubのアカウント（→ [設置の準備](/guide/prepare#githubのアカウントを作る)）
- Vercelのアカウント（→ [Vercelに置く（SkyWay版）の手順1](/skyway/vercel#_1-vercelのアカウントを作る)）
- AxeのOrigin（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）
- `SESSION_SECRET`に入れる乱数（→ [設置の準備](/guide/prepare#乱数を作る-session-secret)）

## 1. Discordのアプリを作る

部屋に入るときのログインに、Discordを使います。
[Discordのアプリを作る](/server/discord)の手順で、アプリを作り、**Client ID**と**Client Secret**を控えます。

Discordのアプリに登録する戻り先のURL（Redirects）は、サーバーのURLが決まってから足します（手順8）。
ここでは、Client IDとClient Secretを控えるところまで進めます。

## 2. Deployボタンを押す

下のボタンを押します。
トークン発行のボタンとは、入れる環境変数が違います。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=ACCESS_CONTROL_ALLOW_ORIGIN,DISCORD_CLIENT_ID,DISCORD_CLIENT_SECRET,SESSION_SECRET&project-name=my-udonarium-rooms-vercel&repository-name=my-udonarium-rooms-vercel)

**Create Git Repository**の欄で、複製先を決めます。

1. Gitのサービスを尋ねられたら、**GitHub**を選びます。
2. 複製先のアカウントには、自分の個人のアカウントを選びます。
3. リポジトリの名前には、`my-udonarium-rooms-vercel`が入っています。そのままで構いません。
4. **Create**を押します。

## 3. 環境変数を入れる

環境変数を入れる欄が4つ出ます。

| 名前                          | 入れる値                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | AxeのOrigin（例：`https://axe.example.com`）。`*`は使えない                          |
| `DISCORD_CLIENT_ID`           | 手順1で控えたClient ID                                                               |
| `DISCORD_CLIENT_SECRET`       | 手順1で控えたClient Secret                                                           |
| `SESSION_SECRET`              | 自分で作った64文字の乱数（→ [設置の準備](/guide/prepare#乱数を作る-session-secret)） |

`ACCESS_CONTROL_ALLOW_ORIGIN`に`*`と書くと、Discordから戻る先として認めないので、だれもログインできません。
AxeのOriginを、名前で書いてください。

## 4. デプロイする

**Deploy**を押し、ビルドが終わるのを待ちます（1〜2分ほど）。
終わったら、プロジェクトの画面（ダッシュボード）に進みます。

この時点では、まだRedisとBlobのストアがつながっていません。
そのため、部屋のサーバーは`config-invalid`を返します。
次の手順でつなげば直ります。

## 5. Redisをつなぐ

Redisは、部屋の状態、部屋の一覧、ログインした人のアカウントを置くデータベースです。
VercelのMarketplaceから、Upstashの無料のRedisを作ってつなぎます。

1. プロジェクトの画面で、左のサイドバーの**Storage**を開きます。
2. Marketplaceのデータベースの中から、**Upstash**の**Redis**を選び、**Install**を押します。続けて出る画面でも、**Install**を押します。
3. **Region**（置く場所）を選びます。日本から使うなら、東京（Tokyo）を選びます。
4. プラン（料金の種類）は、無料のもの（Free）を選び、**Continue**を押します。
5. **Database Name**に名前（例：`udonarium-rooms`）を入れ、**Create**を押します。
6. できたデータベースの画面で、**Connect Project**を押し、このプロジェクトを選びます。
7. 環境（Production、Preview、Development）は、すべてにチェックを入れたままにします。**Custom Prefix**の欄は空のままにします。
8. **Connect**を押します。

つないだら、変数が入ったかを確かめます。

1. 左のサイドバーの**Environment Variables**を開きます。
2. 一覧に、`REDIS_URL`か`KV_URL`があるかを見ます。

どちらかがあれば、次に進みます。
どちらも無いときは、`REDIS_URL`を手で足します。
Upstashのデータベースの画面に出ている、`rediss://`で始まる接続先の文字列をコピーし、**Name**を`REDIS_URL`、**Value**をその文字列にして**Save**を押します。
`https://`で始まるもの（REST APIのURL）は使えません。

## 6. Blobのストアをつなぐ

Vercel Blobは、部屋に置いた画像と音声の置き場です。

1. 左のサイドバーの**Storage**を開き、**Create Storage**を押します。
2. **Blob**を選び、**Continue**を押します。
3. アクセスの種類を**Private**にします。**Public**にすると、URLを知っている人ならだれでも画像と音声を読めてしまいます。あとから変えられないので、間違えたときは作り直します。
4. 名前を入れて作り、このプロジェクトにつなぎます。環境は、すべてにチェックを入れたままにします。

つなぐと、`BLOB_STORE_ID`などの変数がプロジェクトに入ります。
Vercelの上では、これで読み書きできます。

## 7. デプロイし直す

RedisとBlobの変数は、いま動いているデプロイには入っていません。
デプロイし直して、読み込ませます。

1. 左のサイドバーの**Deployments**を開きます。
2. いちばん上（最新）のデプロイの右の **…** から、**Redeploy**を選びます。
3. 確かめる画面が出たら、**Redeploy**を押します。

## 8. URLを控えて、Discordに戻り先を登録する

プロジェクトの画面の最初のページ（Overview）に、本番のドメインが出ています。
`my-udonarium-rooms-vercel.vercel.app`のような名前です。
この前に`https://`を付けたものが、**部屋のサーバーのURL**です。

Discordのアプリに戻り先を登録します（→ [Discordのアプリを作る](/server/discord#_3-戻り先のurlを登録する)）。
登録するURLは、部屋のサーバーのURLの後ろに`/v1/login/discord/callback`を付けたものです。

```text
https://my-udonarium-rooms-vercel.vercel.app/v1/login/discord/callback
```

`*-git-*.vercel.app`のような、プレビューのデプロイのURLは使えません。
プレビューのURLはデプロイのたびに替わるので、そこからはログインできません。

## 9. 動いているか確かめる

ブラウザで、部屋のサーバーのURLを開きます。

```text
https://my-udonarium-rooms-vercel.vercel.app/
```

`{"message":"Hello udonarium-backend-vercel!"}`と出れば、サーバーは動いています。

続いて、設定が読めているかを確かめます。
次のURLを開きます。

```text
https://my-udonarium-rooms-vercel.vercel.app/v1/login/discord
```

| 出たもの                        | 意味                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `{"error":"invalid-request"}`   | 正しく動いています。ログインに要る情報をブラウザから付けていないので断っています。Axeから開くときは、Axeが付けます |
| `{"error":"login-unavailable"}` | ログインの3つ（`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`）が入っていません                    |
| `{"error":"config-invalid"}`    | 設定が足りないか、形が違います。下のログを見てください                                                             |

`config-invalid`のときは、左のサイドバーの**Logs**を開きます。
足りない設定の名前が、ログに出ています。
無料のプランでは、ログは1時間しか残らないので、URLを開いた直後に見てください。
直したら、手順7のとおりデプロイし直します。

ターミナルが使えるなら、Originを付けて確かめることもできます（→ [設置の準備](/guide/prepare#ターミナルから確かめる-使える人だけ)）。
`{"providers":["discord"]}`と返れば、ログインが使えます。

```sh
curl -H "Origin: https://axe.example.com" https://my-udonarium-rooms-vercel.vercel.app/v1/auth/config
```

## 10. Axeにつなぐ

Axeを配信している場所の`assets/config.json`を開き、`transport`を`"server"`にして、`backend.url`に部屋のサーバーのURLを書きます。
書きかたは[設置の準備](/guide/prepare#テキストファイルを書く)にあります。

```json
{
  "transport": "server",
  "backend": {
    "url": "https://my-udonarium-rooms-vercel.vercel.app"
  }
}
```

書き換えた`config.json`を配信先に置き直して、Axeを開きます。

1. ロビーの上に「Discordでログイン」が出ていれば、Axeが部屋のサーバーにつながっています。
2. 「Discordでログイン」を押し、Discordの画面で許可します。Axeに戻り、ログインした名前が出れば、ログインは成功です。
3. 部屋を作ります。作った人がGMになります。
4. ほかのブラウザ（または別の人）から同じ部屋に入れれば、完成です。ログインしていない人は、見学として入ります。

Axe側の設定の詳しい意味は、[Axeの設定](/guide/client-config#サーバー版のとき)にあります。

## 掃除の鍵を入れる（任意）

時間が過ぎた部屋を消す掃除は、`vercel.json`に書いたVercel Cronが1日1回呼びます（`/internal/sweep`）。
環境変数`CRON_SECRET`に乱数を入れておくと、Vercel Cronのほかからは呼べなくなります。

1. [設置の準備](/guide/prepare#乱数を作る-session-secret)と同じ方法で、乱数を作ります。`SESSION_SECRET`とは別のものにします。
2. 左のサイドバーの**Environment Variables**で、**Name**を`CRON_SECRET`、**Value**を作った乱数にし、種類を**Secret**にして**Save**を押します。
3. 手順7のとおりデプロイし直します。

## SkyWayのトークン発行と一緒に置く

同じプロジェクトに`SKYWAY_APP_ID`と`SKYWAY_SECRET`も入れれば、SkyWay版のトークン発行も受け持ちます。
別々のプロジェクトに分けても構いません。
環境変数の足しかたは、[Vercelに置く（SkyWay版）の「設定を直す」](/skyway/vercel#設定を直す)と同じです。

## 独自ドメインで公開する

自分のドメインで公開するときは、プロジェクトの**Settings**の**Domains**から足します。
足したあとは、次の3つをそろえて新しいドメインに変えます。

- Axeの`backend.url`
- Discordのアプリに登録した戻り先のURL（新しいドメインのものを足す）
- 確かめるときに開くURL

Discordの戻り先は、Axeの`backend.url`と同じドメインで登録します。
ドメインが違うと、Discordが`Invalid OAuth2 redirect_uri`を出して、ログインできません。

## 更新するとき

[Vercelに置く（SkyWay版）の「更新するとき」](/skyway/vercel#更新するとき)と同じです。
新しいプロジェクトを作り直すときは、古いプロジェクトにつないでいたRedisとBlobのストアを、新しいプロジェクトにつなぎます（手順5と手順6の、つなぐところ）。
つなげば、部屋と画像はそのまま使えます。
Discordの戻り先とAxeの`backend.url`も、新しいURLに変えます。

## うまくいかないとき

[サーバー版で困ったとき](/server/troubleshooting)を見てください。
