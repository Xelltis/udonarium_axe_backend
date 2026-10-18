# Cloudflareに置く（サーバー版）

サーバー版のAxeで遊ぶための部屋のサーバーを、自分のCloudflareのアカウントに置く手順です。
部屋ごとのDurable Objectが卓の状態を持ち、画像と音声はR2に置きます。
Deploy to Cloudflareのボタンを使うので、ブラウザの操作だけで進められます。
かかる時間は、アカウント作りを含めて1時間ほどです。

<Journey mode="server" here="cloudflare" />

同じWorkerは、SkyWayの2つの値を入れると、SkyWay版のトークン発行サーバーも受け持ちます（→ [Cloudflareに置く（SkyWay版）](/skyway/cloudflare)）。

::: info 画面の言葉
Cloudflareの画面は、日本語でも表示できます（右上のプロフィールから**Settings**の**Language**で選びます）。
このページでは、ボタンやメニューの名前を英語の表示で書きます。
日本語の表示にしているときは、対応する日本語の名前（**Settings**なら「設定」）を探してください。
:::

## 0. 用意するもの

- GitHubのアカウント（→ [設置の準備](/guide/prepare#githubのアカウントを作る)）
- Discordのアカウント（ログインに使うアプリを作るため）
- クレジットカードかPayPal（R2を使い始めるときに登録が要ります。無料枠の中なら請求はありません）
- AxeのOrigin（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）

途中で、次の値を入れたり控えたりします。
パソコンの中にメモのファイルを1つ作り、そこに貼り付けながら進めると迷いません（→ [秘密の値の扱い](/guide/prepare#秘密の値の扱い)）。

| 値                     | 手に入れるところ                                   | 使う手順      |
| ---------------------- | -------------------------------------------------- | ------------- |
| AxeのOrigin            | [設置の準備](/guide/prepare#axeのoriginを確かめる) | 手順6、8      |
| DiscordのClient ID     | 手順3                                              | 手順6         |
| DiscordのClient Secret | 手順3                                              | 手順6         |
| `SESSION_SECRET`       | 手順4                                              | 手順6         |
| 部屋のサーバーのURL    | 手順7                                              | 手順9、10、11 |

## 1. Cloudflareのアカウントを作る

すでにCloudflareのアカウントがあれば、ログインして手順2に進みます。

1. [Cloudflareの登録ページ](https://dash.cloudflare.com/sign-up)を開きます。
2. メールアドレスとパスワードを入れて登録します。GitHubやGoogleのアカウントで登録することもできます。
3. 届いた確認のメールを開き、中のリンクを押します。

無料のプラン（Free）のままで動きます。
部屋のサーバーが使うDurable Objectsも、無料のプランで使えます。

## 2. R2とAnalytics Engineを使い始める（アカウントに一度だけ）

### R2

R2は、部屋に置いた画像と音声の置き場です。
使い始めるには、アカウントで申し込みが要ります。
無料枠（1か月に10GBの保存と、決まった回数の読み書き）の範囲なら、料金はかかりません。
ただし、申し込みには支払い方法の登録が要ります。

1. [Cloudflareのダッシュボード](https://dash.cloudflare.com/)で、左のメニューの**Storage & databases**から**R2 object storage**（または**R2**）を開き、**Overview**を開きます。
2. R2をまだ使っていないアカウントでは、R2を使い始めるための案内と、申し込みのボタン（**Add R2 subscription to my account**など）が出ます。ボタンを押します。
3. 画面に従って、支払い方法（クレジットカードかPayPal）を登録し、申し込みを済ませます。料金は、無料枠を超えて使った分だけです。
4. R2の画面に戻り、バケットの一覧（まだ空です）が出ていれば、使い始められています。

バケット（R2の中の入れ物）は、このあとのデプロイで自動で作られます。
ここでは作りません。

::: warning 申し込みを忘れるとデプロイが失敗します
R2を使い始めていないアカウントでは、バケットを作れずにデプロイが止まります。
エラーに「Please enable R2 through the Cloudflare Dashboard」と出たら、この手順を済ませてからやり直してください。
:::

### Analytics Engine

Analytics Engineは、部屋で起きたこと（入った・出た・削除したなど）の記録の置き場です（→ [部屋の記録](/operate/#部屋の記録)）。
使い始めていないアカウントでは、Workerをデプロイできません。

1. ダッシュボードで、`https://dash.cloudflare.com/<アカウントID>/workers/analytics-engine`を開きます。アカウントIDは、ダッシュボードのURLの`dash.cloudflare.com/`のすぐあとにある英数字です。
2. 空のデータセットを作る画面が出たら、**Dataset Name**に`udonarium_axe_rooms`、**Dataset Binding**に`METRICS`を入れて作ります。部屋のサーバーが書くデータセットと同じ名前です。

::: warning 使い始めていないとデプロイが失敗します
エラーに「You need to enable Analytics Engine」（`code: 10089`）と出たら、この手順を済ませてからやり直してください。
初めてのデプロイがここで止まったときは、その前にR2のバケット（「<Workerの名前>-assets」）だけが作られています。
Workerがまだ無いので、やり直すと同じ名前のバケットを作ろうとして止まります。
中身が空なのを確かめて、そのバケットを消してからやり直してください。
:::

## 3. Discordのアプリを作る

部屋に入るときのログインに、Discordを使います。
[Discordのアプリを作る](/server/discord)の手順で、アプリを作り、**Client ID**と**Client Secret**を控えます。

Discordのアプリに登録する戻り先のURL（Redirects）は、WorkerのURLが決まってから足します（手順9）。
ここでは、Client IDとClient Secretを控えるところまで進めます。

## 4. `SESSION_SECRET`を作る

ログインのトークンに署名するための乱数を作ります。
[設置の準備](/guide/prepare#乱数を作る-session-secret)の手順で64文字の乱数を作り、控えておきます。

## 5. Deployボタンを押す

下のボタンを押します。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Xelltis/udonarium_axe_backend/tree/main/apps/cloudflare)

Cloudflareにログインしていないときは、先にログインの画面が出ます。
ログインすると、Cloudflareのデプロイの画面（「Set up your application」）が開きます。

<DeployMap kind="cloudflare" />

このボタンは、このリポジトリの`apps/cloudflare`だけを、あなたのGitHubに新しいリポジトリとして複製し、そこからCloudflareにデプロイします。
このリポジトリそのものは変わりません。

初めてのときは、CloudflareとGitHubをつなぎます。

1. **Configure repository**の欄の**Git account**を開き、**Connect GitHub**を選びます。
2. GitHubの画面で、**Cloudflare Workers and Pages**というGitHubのアプリを入れるよう求められます。入れる先には、自分の個人のアカウントを選び、**Install**を押します。
3. Cloudflareのデプロイの画面に戻り、**Git account**に自分のGitHubのアカウントが出ていれば、つながっています。

## 6. 設定を入れて、デプロイする

デプロイの画面では、上から順に次のものを決めます。
欄によっては、その下に、このリポジトリが付けた日本語の説明が出ます。

| 項目                              | 入れるもの                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Repository name**               | 複製先のGitHubのリポジトリの名前。そのままで構わない。同じ名前のリポジトリがすでにあると作れない |
| **Create private Git repository** | 複製先を非公開にするかのチェック。どちらでも動く。迷ったらチェックを入れる                       |
| **Worker name**                   | 例：`udonarium-axe-backend`。WorkerのURLと、R2のバケットの名前（`<この名前>-assets`）になる      |
| `ACCESS_CONTROL_ALLOW_ORIGIN`     | AxeのOrigin（例：`https://axe.example.com`）。2つ以上あるときはカンマで区切る。`*`は使えない     |
| `ROOM_RETENTION_HOURS`            | 最後の1人が抜けてから部屋を消すまでの時間。`24`のままで構わない                                  |
| `DISCORD_CLIENT_ID`               | 手順3で控えたClient ID                                                                           |
| `DISCORD_CLIENT_SECRET`           | 手順3で控えたClient Secret                                                                       |
| `SESSION_SECRET`                  | 手順4で作った乱数                                                                                |

- Workerの名前には、英小文字、数字、`-`だけを使います。
- 値は、コピーして貼り付けます。前後に空白や改行が入らないように気をつけてください。
- ログインの3つ（`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`）は、入れないと先に進めない欄です。
- R2のバケットの名前を尋ねる欄が出たときは、そのまま（`<Workerの名前>-assets`）にします。
- ビルドとデプロイのコマンドの欄は、最初から入っているままにします。

すべて入れたら、画面のいちばん下の**Create and deploy**を押します。
リポジトリの複製、R2のバケットの作成、部屋のサーバー（Durable Objects）の作成、Workerのデプロイが、まとめて行われます。

画面は、ビルドの様子（**Build details**と**Build log**）に変わります。
数分かかるので、終わるまで待ちます。
うまくいくと、**Build log**の最後に、`https://<Workerの名前>.<アカウントのサブドメイン>.workers.dev`の形のURLが出ます。

## 7. WorkerのURLを確かめる

1. [Cloudflareのダッシュボード](https://dash.cloudflare.com/)で、左のメニューの**Workers & Pages**を開きます。メニューがまとめて畳まれているときは、**Compute**の中にあります。
2. 一覧から、手順6で付けた名前のWorkerを開きます。
3. Workerの画面の**Domains**のタブに、`https://<Workerの名前>.<アカウントのサブドメイン>.workers.dev`の形のURLが出ています。画面の右上の**Visit**を押しても、そのURLが開きます。

このURLが、**部屋のサーバーのURL**です。
このあとの手順では、`https://udonarium-axe-backend.yourname.workers.dev`として書きます。

デプロイが失敗していたときは、Workerの画面の**Deployments**のタブを開き、いちばん下の**View build history**を押して、失敗したビルドのログを見ます。
原因を直したら、そのビルドの **…** から**Retry build**を選ぶと、やり直せます。
困ったときの見かたは、[サーバー版で困ったとき](/server/troubleshooting#デプロイでつまずく)にあります。

## 8. Originの設定を確かめる

`ACCESS_CONTROL_ALLOW_ORIGIN`と`ROOM_RETENTION_HOURS`は、複製したリポジトリの`wrangler.jsonc`というファイルからも読まれます。
複製したリポジトリに変更が入るたびに、Cloudflareは自動でデプロイし直し、そのとき`wrangler.jsonc`の値で設定を上書きします。
`wrangler.jsonc`の中が手元で試すための値（`http://localhost:4200`）のままだと、次のデプロイでAxeからつながらなくなります。
最初のうちに、ファイルの値を確かめておきます。

1. GitHubで、手順6で複製したリポジトリを開きます。
2. `wrangler.jsonc`を開き、`"ACCESS_CONTROL_ALLOW_ORIGIN"`の行を探します。
3. 値がAxeのOriginになっていれば、手順9に進みます。
4. `"http://localhost:4200"`のままなら、ファイルの右上の鉛筆の形のボタン（**Edit this file**）を押し、`"http://localhost:4200"`を`"https://axe.example.com"`のように、AxeのOriginに書き換えます。前後の`"`は消さないでください。
5. 右上の**Commit changes...** を押し、出てきた画面でもう一度**Commit changes**を押します。

書き換えると、Cloudflareが自動でデプロイし直します。
1〜2分待ってから、次に進みます。

`DISCORD_CLIENT_ID`など、ログインの3つはシークレットとしてWorkerに置かれているので、`wrangler.jsonc`には書きません。
デプロイし直しても消えません。

## 9. Discordに戻り先を登録する

Discordのアプリに、ログインのあとの戻り先を登録します（→ [Discordのアプリを作る](/server/discord#_3-戻り先のurlを登録する)）。
登録するURLは、部屋のサーバーのURLの後ろに`/v1/login/discord/callback`を付けたものです。

```text
https://udonarium-axe-backend.yourname.workers.dev/v1/login/discord/callback
```

あとでカスタムドメインを付けたときは、そのドメインのURLも足します（手順12）。

## 10. 動いているか確かめる

ブラウザで、部屋のサーバーのURLを開きます。

```text
https://udonarium-axe-backend.yourname.workers.dev/
```

`{"message":"Hello udonarium-axe-backend!"}`と出れば、Workerは動いています。
初めてデプロイした直後は、エラーの画面が出ることがあります。
1分ほど待ってから、開き直してください。

続いて、設定が読めているかを確かめます。
次のURLを開きます。

```text
https://udonarium-axe-backend.yourname.workers.dev/v1/login/discord
```

| 出たもの                        | 意味                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `{"error":"invalid-request"}`   | 正しく動いています。ログインに要る情報をブラウザから付けていないので断っています。Axeから開くときは、Axeが付けます |
| `{"error":"login-unavailable"}` | ログインの3つ（`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`）が入っていません                    |
| `{"error":"config-invalid"}`    | 設定が足りないか、形が違います。Workerのログを見てください                                                         |

`login-unavailable`や`config-invalid`のときは、[設定を変えるとき](#設定を変えるとき)を見て直します。
足りない設定の名前は、Workerの画面の**Logs**（または**Observability**）に出ています。

ターミナルが使えるなら、Originを付けて確かめることもできます（→ [設置の準備](/guide/prepare#ターミナルから確かめる-使える人だけ)）。
`{"providers":["discord"]}`と返れば、ログインと部屋が使えます。
`{"providers":[]}`なら、ログインの3つが入っていません。

```sh
curl -H "Origin: https://axe.example.com" https://udonarium-axe-backend.yourname.workers.dev/v1/auth/config
```

## 11. Axeにつなぐ

Axeを配信している場所の`assets/config.json`を開き、`transport`を`"server"`にして、`backend.url`に部屋のサーバーのURLを書きます。
書きかたは[設置の準備](/guide/prepare#テキストファイルを書く)にあります。

```json
{
  "transport": "server",
  "backend": {
    "url": "https://udonarium-axe-backend.yourname.workers.dev"
  }
}
```

書き換えた`config.json`を配信先に置き直して、Axeを開きます。

1. ロビーの上に「Discordでログイン」が出ていれば、Axeが部屋のサーバーにつながっています。
2. 「Discordでログイン」を押し、Discordの画面で許可します。Axeに戻り、ログインした名前が出れば、ログインは成功です。
3. 部屋を作ります。作った人がGMになります。
4. ほかのブラウザ（または別の人）から同じ部屋に入れれば、完成です。ログインしていない人は、見学として入ります。

画像と音声が部屋のサーバーに置かれるかは、開発者ツールの**ネットワーク**で見られます（→ [設置の準備](/guide/prepare#開発者ツールを開く)）。
部屋の中で画像を足すと、`/v1/rooms/<部屋の鍵>/assets/<SHA-256>`へのリクエストが、次のように並びます。

1. 画像を足した人（GMかPL）のブラウザ：`HEAD`（`404`）のあと`PUT`（`201`）
2. ほかの参加者のブラウザ：`GET`（`200`）

Axe側の設定の詳しい意味は、[Axeの設定](/guide/client-config#サーバー版のとき)にあります。

## 12. カスタムドメインを付ける

`*.workers.dev`のURLのままでも遊べますが、**本番ではカスタムドメインを付けてください**。
画像と音声を近くのデータセンターに置いておくしくみ（Cache API）は、`*.workers.dev`では働きません。
そのままだと、毎回R2から読むことになり、遅くなり、読み出しの回数も増えます。

カスタムドメインを付けるには、自分のドメイン（例：`example.com`）を持っていて、そのDNSをCloudflareで管理している必要があります。

### ドメインをCloudflareに移す

まだCloudflareでドメインを管理していないときは、先にドメインを足します。

1. ダッシュボードで**Domains**を開き、**Onboard a domain**を押します。
2. ドメイン（`example.com`の形。`www.`などは付けない）を入れて進み、プランは**Free**を選びます。
3. Cloudflareが、2つのネームサーバーの名前を示します。
4. ドメインを買ったところ（お名前.comなど）の管理画面で、ネームサーバーを、示された2つに書き換えます。DNSSECを使っているときは、先に止めておきます。
5. Cloudflareで切り替わったことが確かめられると、ドメインが有効になります。数時間かかることもあります。

### Workerにドメインを付ける

1. **Workers & Pages**からWorkerを開き、**Domains**のタブを開きます。タブが無いときは、**Settings**の**Domains & Routes**を開きます。
2. ドメインを足すボタン（**Add Domain**、または**Add**から**Custom Domain**）を押します。
3. `backend.example.com`のように、管理しているドメインの下の名前を入れて、足します（**Add Custom Domain**）。
4. 一覧に、入れたドメインが出れば付いています。証明書ができるまで、数分かかることがあります。

DNSのレコードと証明書は、Cloudflareが作ります。

::: warning このWorkerのためだけのホスト名にする
Axeやほかのサービスとは別の、このWorkerのためだけのホスト名にしてください。
置かれたSVGが万一文書として開かれても、そのホスト名のcookieを読ませないためです。
詳しくは[安全のしくみ](/operate/security#svgはサンドボックスに入れて配る)にあります。
:::

ドメインを付けたら、次の3つを新しいドメインに変えます。

- Axeの`config.json`の`backend.url`（例：`https://backend.example.com`）
- Discordのアプリの戻り先（`https://backend.example.com/v1/login/discord/callback`を足す）
- 確かめるときに開くURL

Discordの戻り先は、Axeの`backend.url`と同じドメインで登録します。
`*.workers.dev`で登録したままカスタムドメインから使うと、Discordが`Invalid OAuth2 redirect_uri`を出して、ログインできません。

## 設定を変えるとき

設定は、2つの場所に分かれています。

- `ACCESS_CONTROL_ALLOW_ORIGIN`と`ROOM_RETENTION_HOURS`：複製したリポジトリの`wrangler.jsonc`。GitHubの画面で書き換えます（手順8）。
- ログインの3つ（`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`）：Workerのシークレット。Cloudflareのダッシュボードで書き換えます。

変えかたの手順と、`SESSION_SECRET`を替えたときに起きることは、[設定項目](/server/configuration#値の置き場所)にあります。

## 手元からwranglerでデプロイする

Deployボタンを使わずに、手元からデプロイすることもできます。
Node.jsとGitが入っていて、ターミナルが使える人向けです。

```sh
git clone https://github.com/Xelltis/udonarium_axe_backend.git
cd udonarium_axe_backend/apps/cloudflare
npm ci
npx wrangler login
npx wrangler deploy --name my-udonarium-axe \
  --var ACCESS_CONTROL_ALLOW_ORIGIN:https://axe.example.com
```

- `--name`でWorkerの名前を決めます。R2のバケットは「<この名前>-assets」で、最初のデプロイのときに作られます。部屋のサーバーのDurable Objectsも、このときに作られます。
- `--var`で、`wrangler.jsonc`に書いてある手元用の値（`http://localhost:4200`）を差し替えます。
- 2回目からは同じコマンドで更新でき、バケットはそのまま使い続けます。

ログインを使うときは、最初のデプロイのあとに、3つをシークレットとして入れます。
シークレットは、デプロイし直しても残ります。

```sh
npx wrangler secret put DISCORD_CLIENT_ID --name my-udonarium-axe
npx wrangler secret put DISCORD_CLIENT_SECRET --name my-udonarium-axe
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --name my-udonarium-axe
```

## 何台も置くとき

身内用と公開用など、同じCloudflareアカウントに何台でも置けます。
Workerの名前を変えてデプロイすれば、R2のバケットも部屋もWorkerごとに別々に作られ、レート制限も別々に数えます。
Deployボタンで置くときは、リポジトリの名前とWorkerの名前を、両方とも前と違うものにします。

## 更新するとき

Deployボタンで作ったリポジトリは、このリポジトリとは別のものです。
このリポジトリが新しくなっても、あなたのWorkerは自動では変わりません。
新しい版を取り込むには、このリポジトリの`apps/cloudflare`の変更を、複製したリポジトリに取り込みます。
複製したリポジトリに変更が入ると、Cloudflareが自動でデプロイし直します（Workers Builds）。

取り込むときに`wrangler.jsonc`を上書きすると、`ACCESS_CONTROL_ALLOW_ORIGIN`が`http://localhost:4200`に戻ります。
取り込んだあとに、手順8のとおり確かめてください。

## 次に読むもの

- [設定項目](/server/configuration)
- [運用](/operate/)と[費用と上限](/operate/costs)
- [困ったとき](/server/troubleshooting)
