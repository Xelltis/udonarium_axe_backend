# 自分のリポジトリから自動でデプロイする

このリポジトリでは、GitHub Actionsが、Cloudflare版のWorkerとVercel版のプロジェクトを自動でデプロイできます。
このページは、このリポジトリをフォークして、自分で運用する人向けです。
Deployボタンで置いた人は、CloudflareかVercelが自動でデプロイし直すので、この設定は要りません。

## しくみ

1. `main`にpushされると、`Release`のワークフローが、CIのジョブ（各アプリのlint、型検査、テストと、文書のビルド）を流します。
2. それが通ると、リリースを作ります。リリースが出るのは、前のリリースから`feat`か`fix`のコミットが入ったときです。
3. リリースが出たら、`Deploy`のワークフローが、そのタグの中身を、デプロイ先のGitHub Environmentごとにデプロイします。Cloudflare版は`wrangler deploy`で、Vercel版はVercelのCLIでビルドして送ります。
4. 同じEnvironmentへのデプロイは、1つずつ順に行います。

リリースが出ないpush（文書、CI、依存の更新だけのもの）では、デプロイしません。
いくつかまとめて入れても、デプロイは次のリリースのときの1回で済みます。

リリースを作るには、リポジトリのSecret`RELEASE_TOKEN`が要ります。
`RELEASE_TOKEN`が無いリポジトリ（ふつうのフォーク）では、リリースを作らずに、pushのたびに`main`に入った中身をデプロイします。

デプロイ先を書かなければ、`Deploy`は何もしません。
フォークしただけのリポジトリで、勝手にデプロイが走ることはありません。

## Cloudflare版を設定する

### 1. GitHub Environmentを作る

リポジトリの「Settings → Environments」で、デプロイ先ごとにEnvironmentを作ります。
名前は自由です（例：身内用の`cloudflare-production`と公開用の`cloudflare-public`）。

それぞれのEnvironmentで、「Deployment branches and tags」を**Selected branches**にし、`main`だけを許可します。
こうすると、`main`以外のブランチのワークフローからは、このEnvironmentのSecretを読めません。

### 2. Secretを入れる

Environmentごとに、次のSecretを入れます。

| 名前                          | 中身                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `WORKER_NAME`                 | Workerの名前。Environmentごとに変える。R2のバケットは「<この名前>-assets」になる        |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | そのWorkerで受けるAxeのOrigin。カンマ区切りで複数書ける                                 |
| `CLOUDFLARE_API_TOKEN`        | デプロイに使うCloudflareのAPIトークン（下の「APIトークン」を参照）                      |
| `CLOUDFLARE_ACCOUNT_ID`       | CloudflareのアカウントID。全部のEnvironmentで同じなら、リポジトリのSecretに置いてもよい |
| `DISCORD_CLIENT_ID`           | ログインに使うDiscordのアプリのClient ID（ログインと部屋を使うとき）                    |
| `DISCORD_CLIENT_SECRET`       | 同じアプリのClient Secret                                                               |
| `SESSION_SECRET`              | トークンに署名する鍵。32文字以上の乱数。Environmentごとに別のものにする                 |
| `SKYWAY_APP_ID`               | SkyWayのアプリケーションID（SkyWay版のトークンを発行するとき）                          |
| `SKYWAY_SECRET`               | 同じアプリのシークレットキー                                                            |
| `ADMIN_DISCORD_IDS`           | 管理画面に入れる運営する人のDiscordのユーザーID。カンマ区切り（管理画面を使うとき）     |
| `ADMIN_WEBHOOK_URL`           | 運営する人への知らせを送るDiscordのWebhookのURL（知らせを受けるとき）                   |
| `ADMIN_CONTACT_URL`           | 断った人に見せる問い合わせ先。`https://`のページか`mailto:`（出すとき）                 |
| `ROOM_STORAGE_LIMIT_MB`       | 1つの部屋に置ける画像と音声の合計（MB）（上限を置くとき）                               |
| `ADMIN_STORAGE_ALERT_GB`      | 置き場所の合計がこの量（GB）を超えたら知らせる（数えるとき）                            |

ログインの3つは、そろえて入れるか、どれも入れないかのどちらかにします。一部だけだと、デプロイのジョブが止まります。
SkyWayの2つも同じです。ログインの3つだけを入れたEnvironmentは部屋のサーバーに、SkyWayの2つだけを入れたEnvironmentはSkyWay版のトークン発行サーバー（→ [Cloudflareに置く（SkyWay版）](/skyway/cloudflare)）になり、両方を入れると両方を受け持ちます。
Discordのアプリの作りかたは[Discordのアプリを作る](/server/discord)にあります。

運営する人の設定（`ADMIN_`で始まる4つと`ROOM_STORAGE_LIMIT_MB`）は、どれも入れなくてもかまいません（→ [管理画面とBAN](/operate/admin)、[設定項目](/server/configuration)）。
入れたものは、デプロイの前に形を確かめ、合わなければジョブを止めます。
形の合わない設定があると、Workerはすべてのリクエストに`500 config-invalid`を返すためです。
デプロイは、Workerにあるシークレットへ足すだけです。
Environmentから消しても、Workerには残ります。
外すときは、Cloudflareのダッシュボードか`wrangler secret delete`で消します。
`ADMIN_PASSKEY_RESET`は、パスキーをすべて失くしたときだけ入れて外すものなので、ここには入れず、ダッシュボードで扱います（→ [端末を失くしたとき](/operate/admin#端末を失くしたとき)）。

`ACCESS_CONTROL_ALLOW_ORIGIN`、ログインの3つ、SkyWayの2つ、入れた運営する人の設定は、デプロイのたびにWorkerのシークレットとして入れ直します。
`wrangler.jsonc`に書いた手元用の値（`http://localhost:4200`）は、このシークレットで置き換わります。

`gh`コマンドを使うと、次のように入れられます。

```sh
R=<owner>/<repo>
E=cloudflare-production
gh secret set WORKER_NAME --env $E --repo $R --body udonarium-axe-production
gh secret set ACCESS_CONTROL_ALLOW_ORIGIN --env $E --repo $R --body https://axe.example.com
gh secret set CLOUDFLARE_API_TOKEN --env $E --repo $R      # 実行すると値を尋ねられる
gh secret set CLOUDFLARE_ACCOUNT_ID --repo $R --body <アカウントID>
gh secret set DISCORD_CLIENT_ID --env $E --repo $R --body <Client ID>
gh secret set DISCORD_CLIENT_SECRET --env $E --repo $R  # 値を尋ねられる
openssl rand -base64 48 | gh secret set SESSION_SECRET --env $E --repo $R
```

### 3. デプロイ先を書く

リポジトリの「Settings → Secrets and variables → Actions → Variables」で、Variable `CLOUDFLARE_DEPLOY_ENVIRONMENTS`に、Environmentの名前をJSONの配列で書きます。

```json
["cloudflare-production", "cloudflare-public"]
```

```sh
gh variable set CLOUDFLARE_DEPLOY_ENVIRONMENTS --repo $R --body '["cloudflare-production","cloudflare-public"]'
```

次にリリースが出たときから、デプロイが走ります（リリースを作らないフォークでは、次に`main`へpushしたときから）。
すぐに出すときは、[値を変えたとき](#値を変えたとき)と同じく、`Deploy`のワークフローを手で起動します。

### APIトークン

APIトークンは、Cloudflareのダッシュボードの「My Profile → API Tokens」（またはアカウントの「API Tokens」）で作ります。
権限は、必要な最小限に絞ってください。

| 時期                       | 権限                           | 範囲                             |
| -------------------------- | ------------------------------ | -------------------------------- |
| Workerを初めてデプロイする | Workers Admin                  | すべてのWorker（新しく作るため） |
|                            | Workers R2 Storage Write・Read | アカウント（バケットを作るため） |
| 2回目から                  | Workers Editor                 | デプロイするWorkerだけ           |

- 「Account Resources」は、そのアカウントだけを選びます。
- ゾーンの権限は要りません。カスタムドメインはダッシュボードで付けるので、デプロイではゾーンに触りません。
- すべてのEnvironmentで初回のデプロイが済んだら、トークンを「Workers Editor（デプロイするWorkerだけ）」に絞ってください。2回目からは、デプロイ済みのWorkerからバケットの割り当てを引き継ぐので、R2の権限は要りません。
- 「選んだWorkerだけ」の範囲は、そのWorkerができてからでないと選べません。そのため、初回だけは広い権限が要ります。
- 部屋のサーバーのDurable Objectsは、Workerと一緒にデプロイされます。別の権限は要りません。すでに置いてあるWorkerに、部屋のサーバーの入った版を初めて出すとき`Authentication error`になったら、その1回だけ初回と同じ権限でデプロイし直してください。

## Vercel版を設定する

Vercel版は、VercelのGitの連携を使わずに、ActionsからVercelのCLIで送ります。
Gitの連携があると、`main`へのpushのたびに本番が変わり、リリースした版とずれるためです。

### 1. プロジェクトを作る

手元で、このリポジトリの`apps/vercel`から、Vercelのプロジェクトを作ります。

```sh
cd apps/vercel
npm ci
npx vercel login
npx vercel link
```

- `vercel link`で、新しいプロジェクトを作るほうを選び、名前を入れます。コードの場所を尋ねられたら`./`のままにします。プロジェクトのRoot Directoryは空のままにします。ActionsはCLIを`apps/vercel`で動かすためです。
- できると、`apps/vercel/.vercel/project.json`に`orgId`と`projectId`が書かれます。手順3で使うので控えます。このファイルはGitに入りません。
- プロジェクトの**Settings**の**Git**で、Gitのリポジトリがつながっていないかを確かめます。つながっていたら外します。

### 2. プロジェクトの設定を入れる

部屋のサーバーの値は、GitHubではなく、Vercelのプロジェクトに置きます。
入れかたは[Vercelに置く（サーバー版）](/server/vercel)と同じです。

- 環境変数の`ACCESS_CONTROL_ALLOW_ORIGIN`、`DISCORD_CLIENT_ID`、`DISCORD_CLIENT_SECRET`、`SESSION_SECRET`（→ [手順3](/server/vercel#_3-環境変数を入れる)）。プロジェクトの**Settings**の**Environment Variables**で入れます。
- Redis（→ [手順5](/server/vercel#_5-redisをつなぐ)）と、Blobのストア（→ [手順6](/server/vercel#_6-blobのストアをつなぐ)）
- 掃除の鍵の`CRON_SECRET`（任意。→ [掃除の鍵を入れる](/server/vercel#掃除の鍵を入れる-任意)）

ビルドのときに、Actionsがこの値をプロジェクトから読みます。

### 3. GitHub EnvironmentとSecretを入れる

Cloudflare版の[手順1](#_1-github-environmentを作る)と同じく、Environmentを作り（例：`vercel-production`）、`main`だけを許可します。
そこに次のSecretを入れます。

| 名前                | 中身                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`      | デプロイに使うVercelのトークン。アカウントのトークンの画面（`https://vercel.com/account/tokens`）で作る |
| `VERCEL_ORG_ID`     | 手順1の`project.json`の`orgId`                                                                          |
| `VERCEL_PROJECT_ID` | 手順1の`project.json`の`projectId`                                                                      |

```sh
R=<owner>/<repo>
E=vercel-production
gh secret set VERCEL_TOKEN --env $E --repo $R      # 値を尋ねられる
gh secret set VERCEL_ORG_ID --env $E --repo $R --body <orgId>
gh secret set VERCEL_PROJECT_ID --env $E --repo $R --body <projectId>
```

### 4. デプロイ先を書く

Variable `VERCEL_DEPLOY_ENVIRONMENTS`に、Environmentの名前をJSONの配列で書きます。

```sh
gh variable set VERCEL_DEPLOY_ENVIRONMENTS --repo $R --body '["vercel-production"]'
```

初めてのデプロイは、[値を変えたとき](#値を変えたとき)と同じく、`Deploy`のワークフローを手で起動します。
終わったら、プロジェクトの本番のURLを控えて、Discordに戻り先を登録します（→ [手順8](/server/vercel#_8-urlを控えて、discordに戻り先を登録する)）。

## 値を変えたとき

GitHubのSecretやVariable、Vercelのプロジェクトの環境変数を変えても、すぐには反映されません。
手でデプロイし直します。

1. GitHubの「Actions」で、左の一覧から`Deploy`を開き、**Run workflow**を押します。
2. ブランチは`main`のままにします。Environmentは`main`からしか使えないためです。
3. `ref`に、いま出ている版のタグ（リリースの一覧のいちばん新しいもの。例：`v1.1.0`）を入れます。リリースを作らないフォークでは`main`を入れます。
4. `app`で、デプロイし直すアプリを選びます。片方の値だけを変えたときは、そのアプリ（`cloudflare`か`vercel`）にします。Cloudflare版をデプロイし直すと、部屋のサーバーが入れ替わり、遊んでいる人の接続がいったん切れるためです（Axeはつなぎ直します）。
5. **Run workflow**を押すと、新しい値でデプロイし直します。

## うまくいかないとき

| ジョブのログ                                                 | 原因と直しかた                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_NAME is not configured for the … environment`        | そのEnvironmentに`WORKER_NAME`が無い                                                                                                                            |
| `ACCESS_CONTROL_ALLOW_ORIGIN is not configured for the …`    | そのEnvironmentに`ACCESS_CONTROL_ALLOW_ORIGIN`が無い                                                                                                            |
| `Please enable R2 through the Cloudflare Dashboard`          | アカウントでR2を使い始めていない（→ [Cloudflareに置く](/server/cloudflare#r2)）                                                                                 |
| `You need to enable Analytics Engine`（`10089`）             | アカウントでAnalytics Engineを使い始めていない（→ [Cloudflareに置く](/server/cloudflare#analytics-engine)）                                                     |
| 同じ名前のR2のバケットがあって作れない                       | 初めてのデプロイが途中で止まり、バケットだけが残っている。空なのを確かめて消してから、やり直す（→ [Cloudflareに置く](/server/cloudflare#analytics-engine)）     |
| `Authentication error`（`10000`など）                        | APIトークンの権限が足りない。初回は上の表の広い権限が要る                                                                                                       |
| `VERCEL_TOKEN is not configured for the … environment`       | そのEnvironmentに`VERCEL_TOKEN`が無い。`VERCEL_ORG_ID`と`VERCEL_PROJECT_ID`も同じ                                                                               |
| Vercel版のデプロイで、部屋のサーバーが`config-invalid`を返す | プロジェクトの環境変数か、RedisかBlobのストアが足りない（→ [Vercel版の手順2](#_2-プロジェクトの設定を入れる)）。足したら、手でデプロイし直す                    |
| `Deploy`のジョブが「skipped」になる                          | リリースが出なかった（`feat`か`fix`のコミットが無かった）、その前のCIのジョブが落ちた、または`CLOUDFLARE_DEPLOY_ENVIRONMENTS`か`VERCEL_DEPLOY_ENVIRONMENTS`が空 |
