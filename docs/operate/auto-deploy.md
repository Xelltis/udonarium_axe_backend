# 自分のリポジトリから自動でデプロイする（Cloudflare版）

このリポジトリでは、`main`に入った変更を、GitHub Actionsが自動でCloudflare版のWorkerにデプロイできます。
このページは、このリポジトリをフォークして、自分で運用する人向けです。
Deployボタンで置いた人は、Cloudflareが自動でデプロイし直すので、この設定は要りません。

## しくみ

1. `main`にpushされると、`Release`のワークフローが、CIのジョブ（各アプリのlint、型検査、テストと、文書のビルド）を流します。
2. それが通ると、リリースを作ります。リリースが出るのは、前のリリースから`feat`か`fix`のコミットが入ったときです。
3. リリースが出たら、`Deploy`のワークフローが、そのタグの中身を、デプロイ先のGitHub Environmentごとに`wrangler deploy`します。
4. 同じEnvironmentへのデプロイは、1つずつ順に行います。

リリースが出ないpush（文書、CI、依存の更新だけのもの）では、デプロイしません。
いくつかまとめて入れても、デプロイは次のリリースのときの1回で済みます。

リリースを作るには、リポジトリのSecret`RELEASE_TOKEN`が要ります。
`RELEASE_TOKEN`が無いリポジトリ（ふつうのフォーク）では、リリースを作らずに、pushのたびに`main`に入った中身をデプロイします。

デプロイ先を書かなければ、`Deploy`は何もしません。
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
| `SKYWAY_APP_ID`               | SkyWayのアプリケーションID（SkyWay版のトークンを発行するとき）                          |
| `SKYWAY_SECRET`               | 同じアプリのシークレットキー                                                            |

ログインの3つは、そろえて入れるか、どれも入れないかのどちらかにします。一部だけだと、デプロイのジョブが止まります。
SkyWayの2つも同じです。ログインの3つだけを入れたEnvironmentは部屋のサーバーに、SkyWayの2つだけを入れたEnvironmentはSkyWay版のトークン発行サーバー（→ [Cloudflareに置く（SkyWay版）](/skyway/cloudflare)）になり、両方を入れると両方を受け持ちます。
Discordのアプリの作りかたは[Discordのアプリを作る](/server/discord)にあります。

`ACCESS_CONTROL_ALLOW_ORIGIN`、ログインの3つ、SkyWayの2つは、デプロイのたびにWorkerのシークレットとして入れ直します。
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
手でデプロイし直します。

1. GitHubの「Actions」で、左の一覧から`Deploy`を開き、**Run workflow**を押します。
2. ブランチは`main`のままにします。Environmentは`main`からしか使えないためです。
3. `ref`に、いま出ている版のタグ（リリースの一覧のいちばん新しいもの。例：`v1.1.0`）を入れます。リリースを作らないフォークでは`main`を入れます。
4. **Run workflow**を押すと、新しい値でデプロイし直します。

## うまくいかないとき

| ジョブのログ                                              | 原因と直しかた                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_NAME is not configured for the … environment`     | そのEnvironmentに`WORKER_NAME`が無い                                                                                                                        |
| `ACCESS_CONTROL_ALLOW_ORIGIN is not configured for the …` | そのEnvironmentに`ACCESS_CONTROL_ALLOW_ORIGIN`が無い                                                                                                        |
| `Please enable R2 through the Cloudflare Dashboard`       | アカウントでR2を使い始めていない（→ [Cloudflareに置く](/server/cloudflare#r2)）                                                                             |
| `You need to enable Analytics Engine`（`10089`）          | アカウントでAnalytics Engineを使い始めていない（→ [Cloudflareに置く](/server/cloudflare#analytics-engine)）                                                 |
| 同じ名前のR2のバケットがあって作れない                    | 初めてのデプロイが途中で止まり、バケットだけが残っている。空なのを確かめて消してから、やり直す（→ [Cloudflareに置く](/server/cloudflare#analytics-engine)） |
| `Authentication error`（`10000`など）                     | APIトークンの権限が足りない。初回は上の表の広い権限が要る                                                                                                   |
| `Deploy`が「skipped」になる                               | リリースが出なかった（`feat`か`fix`のコミットが無かった）、その前のCIのジョブが落ちた、または`CLOUDFLARE_DEPLOY_ENVIRONMENTS`が空                           |
