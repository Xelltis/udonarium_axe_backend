# mainからの自動デプロイ

このリポジトリでは、`main`に入った変更を、GitHub Actionsが自動でCloudflareにデプロイします。
このページは、このリポジトリ（またはそのフォーク）を自分で運用する人向けです。
Deployボタンで置いた人は、Cloudflareが自動でデプロイし直すので、この設定は要りません。

## しくみ

1. `main`にpushされると、CIの`Cloudflare`ジョブ（lint、型検査、テスト）が走ります。
2. それが通ると、`deploy-cloudflare`ジョブが、デプロイ先のGitHub Environmentごとに`wrangler deploy`を実行します。
3. 同じEnvironmentへのデプロイは、1つずつ順に行います。

デプロイ先を書かなければ、このジョブは何もしません。
フォークしただけのリポジトリで、勝手にデプロイが走ることはありません。

## 設定する

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

ログインの3つは、そろえて入れるか、どれも入れないかのどちらかにします。一部だけだと、デプロイのジョブが止まります。
Discordのアプリの作りかたは[ログインと役割](/cloudflare/login#ログインを使えるようにする)にあります。

`ACCESS_CONTROL_ALLOW_ORIGIN`とログインの3つは、デプロイのたびにWorkerのシークレットとして入れ直します。
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

次に`main`へpushしたときから、デプロイが走ります。

## APIトークン

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

## 値を変えたとき

SecretやVariableを変えても、すぐには反映されません。
GitHubの「Actions」で、`main`の最新のCIを開き、**Re-run all jobs**を押すと、新しい値でデプロイし直します。

## うまくいかないとき

| ジョブのログ                                              | 原因と直しかた                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `WORKER_NAME is not configured for the … environment`     | そのEnvironmentに`WORKER_NAME`が無い                                                                            |
| `ACCESS_CONTROL_ALLOW_ORIGIN is not configured for the …` | そのEnvironmentに`ACCESS_CONTROL_ALLOW_ORIGIN`が無い                                                            |
| `Please enable R2 through the Cloudflare Dashboard`       | アカウントでR2を使い始めていない（→ [デプロイする](/cloudflare/deploy#_1-r2を使い始める-アカウントに一度だけ)） |
| `Authentication error`（`10000`など）                     | APIトークンの権限が足りない。初回は上の表の広い権限が要る                                                       |
| ジョブが「skipped」になる                                 | `CLOUDFLARE_DEPLOY_ENVIRONMENTS`が空か、`main`へのpushではない                                                  |
