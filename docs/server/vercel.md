# Vercelに置く（サーバー版）

サーバー版のAxeで遊ぶための部屋のサーバーを、Vercelに置く手順です。
Cloudflare版と同じ部屋のサーバーが、VercelとRedisとVercel Blobの上で動きます。
かかる時間は、アカウント作りを含めて1時間ほどです。

<Journey mode="server" here="vercel" />

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

途中で、次の値を入れたり控えたりします。
パソコンの中にメモのファイルを1つ作り、そこに貼り付けながら進めると迷いません（→ [秘密の値の扱い](/guide/prepare#秘密の値の扱い)）。

| 値                     | 手に入れるところ                                       | 使う手順     |
| ---------------------- | ------------------------------------------------------ | ------------ |
| AxeのOrigin            | [設置の準備](/guide/prepare#axeのoriginを確かめる)     | 手順3        |
| DiscordのClient ID     | 手順1                                                  | 手順3        |
| DiscordのClient Secret | 手順1                                                  | 手順3        |
| `SESSION_SECRET`       | [設置の準備](/guide/prepare#乱数を作る-session-secret) | 手順3        |
| 部屋のサーバーのURL    | 手順8                                                  | 手順8、9、10 |

## 1. Discordのアプリを作る

部屋に入るときのログインに、Discordを使います。
[Discordのアプリを作る](/server/discord)の手順で、アプリを作り、**Client ID**と**Client Secret**を控えます。

Discordのアプリに登録する戻り先のURL（Redirects）は、サーバーのURLが決まってから足します（手順8）。
ここでは、Client IDとClient Secretを控えるところまで進めます。

## 2. Deployボタンを押す

下のボタンを押します。
トークン発行のボタンとは、入れる環境変数が違います。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=ACCESS_CONTROL_ALLOW_ORIGIN,DISCORD_CLIENT_ID,DISCORD_CLIENT_SECRET,SESSION_SECRET&envDescription=%E3%81%9D%E3%82%8C%E3%81%9E%E3%82%8C%E3%81%AE%E6%AC%84%E3%81%AB%E5%85%A5%E3%82%8C%E3%82%8B%E5%80%A4%E3%81%AF%E3%80%81Learn%20More%E3%81%8B%E3%82%89%E9%96%8B%E3%81%8F%E6%89%8B%E9%A0%86%E3%81%AE%E3%83%9A%E3%83%BC%E3%82%B8%E3%81%AB%E3%81%82%E3%82%8A%E3%81%BE%E3%81%99%E3%80%82&envLink=https%3A%2F%2Fxelltis.github.io%2Fudonarium_axe_backend%2Fserver%2Fvercel%23_3-%E7%92%B0%E5%A2%83%E5%A4%89%E6%95%B0%E3%82%92%E5%85%A5%E3%82%8C%E3%82%8B&project-name=my-udonarium-rooms-vercel&repository-name=my-udonarium-rooms-vercel)

<DeployMap kind="vercel-rooms" />

**New Project**の画面が開くので、複製先のリポジトリを作ります。
画面の進みかたは、[Vercelに置く（SkyWay版）の手順3](/skyway/vercel#_3-複製先のリポジトリを決める)と同じです。
リポジトリの名前の欄には、`my-udonarium-rooms-vercel`が入っています。そのままで構いません。

## 3. 環境変数を入れる

**Add Environment Variables**のカードに、環境変数を入れる欄が4つ出ます。
左の**Name**には名前が入っているので、右の**Value**に値を入れます。

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
「Deployment completed.」と出て、デプロイできたことを知らせる画面に変わったら、ダッシュボードへ進むボタンを押して、プロジェクトの画面に進みます。

この時点では、まだRedisとBlobのストアがつながっていません。
そのため、部屋のサーバーは`config-invalid`を返します。
次の手順でつなげば直ります。

## 5. Redisをつなぐ

Redisは、部屋の状態、部屋の一覧、ログインした人のアカウントを置くデータベースです。
VercelのMarketplaceから、Upstashの無料のRedis（**Upstash for Redis**）を作ってつなぎます。

1. プロジェクトの画面で、左のサイドバーの**Storage**を開きます。
2. データベースを作るボタン（**Create Database**か**Create Storage**）を押し、Marketplaceのデータベースの一覧を出します。
3. 一覧から、**Upstash for Redis**（Upstashの行）を選びます。名前が**Redis**だけの行は、Redis Cloudという別のサービスなので選びません。
4. **Install**を押します。初めてUpstashを使うときは「Install Upstash」の画面が出るので、**Create New Upstash Account**を選んで**Continue**を押します。
5. **Primary Region**（置く場所）で、東京（**Tokyo**、`hnd1`）を選びます。部屋のサーバーも東京で動くので、近くに置くと速くなります。あとから変えられません。
6. **Read Regions**は空のまま、**Eviction**はオフのままにします。**Eviction**をオンにすると、データベースがいっぱいになったときに、部屋のデータが消されることがあります。
7. プラン（料金の種類）は、無料の**Free**を選び、**Continue**を押します。**Prod Pack**と**Auto Upgrade**は有料のものなので、選びません。
8. **Database Name**に名前（例：`udonarium-rooms`）を入れ、**Create**を押します。
9. できたデータベースの画面で、**Connect Project**を押します。
10. 「Connect Project」の画面で、このプロジェクトを選びます。**Environments**は、Development、Preview、Productionのすべてにチェックが入ったままにします。**Custom Prefix**の欄は空のままにします。
11. **Connect**を押します。

Freeのプランで作れるデータベースは、1つのUpstashのアカウントに1つまでです。
1か月に使えるコマンドの数などにも上限があります（→ [料金と上限](/operate/costs#vercel版)）。

つないだら、変数が入ったかを確かめます。

1. 左のサイドバーの**Environment Variables**を開きます。
2. 一覧に、`REDIS_URL`か`KV_URL`があるかを見ます。ほかに`KV_REST_API_URL`などの変数も入りますが、部屋のサーバーは使いません。

どちらかがあれば、次に進みます。
どちらも無いときは、`REDIS_URL`を手で足します。
Upstashのデータベースの画面に出ている、`rediss://`で始まる接続先の文字列をコピーし、**Name**を`REDIS_URL`、**Value**をその文字列にして**Save**を押します。
`https://`で始まるもの（REST APIのURL）は使えません。

## 6. Blobのストアをつなぐ

Vercel Blobは、部屋に置いた画像と音声の置き場です。

1. 左のサイドバーの**Storage**を開き、**Create Storage**を押します。
2. **Blob**を選び、**Continue**を押します。
3. アクセスの種類を**Private**にします。**Public**にすると、URLを知っている人ならだれでも画像と音声を読めてしまいます。あとから変えられないので、間違えたときは作り直します。
4. 置く場所（リージョン）を選ぶ欄で、東京（**Tokyo**、`hnd1`）を選びます。これも、あとから変えられません。
5. 名前（例：`udonarium-rooms-assets`）を入れて、**Create a new Blob store**を押します。
6. つなぐ環境を尋ねられます。最初はProductionとPreviewにチェックが入っているので、そのままにします。

つなぐと、`BLOB_STORE_ID`と`BLOB_READ_WRITE_TOKEN`などの変数がプロジェクトに入ります。
**Environment Variables**の一覧で、`BLOB_STORE_ID`があるかを確かめます。
Vercelの上では、これで読み書きできます。

## 7. デプロイし直す

RedisとBlobの変数は、いま動いているデプロイには入っていません。
デプロイし直して、読み込ませます。
やりかたは、[Vercelに置く（SkyWay版）の「設定を直す」](/skyway/vercel#設定を直す)の、デプロイし直す手順と同じです。
**Deployments**のいちばん上のデプロイの **…** から**Redeploy**を選び、ビルドのキャッシュは使わずにデプロイし直します。

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
