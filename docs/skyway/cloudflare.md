# Cloudflareに置く（SkyWay版）

SkyWay版のAxeで遊ぶためのトークン発行サーバーを、Cloudflare Workersに置く手順です。
部屋のサーバー（サーバー版）と同じWorkerのコードで、SkyWayのアプリIDとシークレットキーを入れると、トークンを発行します。
ターミナルでコマンドを打てる人向けで、かかる時間は30分ほどです。

<Journey mode="skyway" here="cloudflare" />

Axeから見た動きは、PHP版・Vercel版と同じです（→ [SkyWay版のしくみ](/skyway/)）。
同じWorkerにログインの3つも入れれば、部屋のサーバーとしても使えます（→ [Cloudflareに置く（サーバー版）](/server/cloudflare)）。

::: info Deployボタンは使いません
[Cloudflareに置く（サーバー版）](/server/cloudflare)のDeployボタンは、ログインの3つを入れないと先に進めません。
SkyWay版だけを置くときは、このページのとおり、手元からwranglerでデプロイします。
:::

## 0. 用意するもの

- Cloudflareのアカウントと、R2を使い始める操作（→ [Cloudflareに置く（サーバー版）](/server/cloudflare#_1-cloudflareのアカウントを作る)の手順1と2）
- SkyWayのアプリケーションIDとシークレットキー（→ [SkyWayのアプリを作る](/skyway/app)）
- AxeのOrigin（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）
- Node.jsとGitが入ったパソコン

R2は、部屋のサーバーが画像と音声を置くところです。
SkyWay版だけなら使いませんが、同じWorkerのコードなので、最初のデプロイで空のバケットが1つ作られます。
空のバケットに料金はかかりません。

## 1. デプロイする

```sh
git clone https://github.com/Xelltis/udonarium_axe_backend.git
cd udonarium_axe_backend/apps/cloudflare
npm ci
npx wrangler login
npx wrangler deploy --name my-udonarium-skyway \
  --var ACCESS_CONTROL_ALLOW_ORIGIN:https://axe.example.com
```

- `--name`でWorkerの名前を決めます。WorkerのURLは`https://<この名前>.<アカウントのサブドメイン>.workers.dev`になります。
- `--var`で、AxeのOriginを入れます。2つ以上あるときはカンマで区切ります。
- 最後に出るURLを控えます。

## 2. SkyWayの2つを入れる

SkyWayのアプリケーションIDとシークレットキーを、Workerのシークレットとして入れます。
シークレットは、デプロイし直しても残ります。

```sh
npx wrangler secret put SKYWAY_APP_ID --name my-udonarium-skyway
npx wrangler secret put SKYWAY_SECRET --name my-udonarium-skyway
```

コマンドを打つと値を尋ねられるので、それぞれ貼り付けます。
2つはそろえて入れます。
片方だけのときや、入れていないときは、トークンを頼まれると`500 CONFIG_INVALID`を返します。

ロビーの数とトークンの有効期間を変えるときは、`SKYWAY_UDONARIUM_LOBBY_SIZE`と`SKYWAY_TOKEN_TTL_SECONDS`も同じように入れます（→ [設定項目](/skyway/configuration)）。

## 3. 動いているか確かめる

AxeのOriginを付けて、`/v1/status`を開きます。

```sh
curl -H 'Origin: https://axe.example.com' https://my-udonarium-skyway.example.workers.dev/v1/status
```

`OK`と返れば、トークンを発行できます。
`{"error":{"code":"CONFIG_INVALID",…}}`が返るときは、手順2の2つが入っていません。
`ORIGIN_FORBIDDEN`が返るときは、手順1の`--var`のOriginと、`curl`に付けたOriginが違います。

## 4. Axeにつなぐ

Axeの`config.json`の`backend.url`に、手順1で控えたURLを入れます（→ [Axeの設定](/guide/client-config)）。
`transport`は書かないか、`skyway`にします。

## GitHub Actionsで自動でデプロイする

このリポジトリのGitHub Actionsでデプロイしている人は、Environmentのシークレットに`SKYWAY_APP_ID`と`SKYWAY_SECRET`を足すと、次のデプロイからトークンを発行します（→ [自動デプロイ](/operate/auto-deploy)）。
ログインの3つを入れないEnvironmentは、SkyWay版だけのWorkerになります。

## 更新するとき

このリポジトリを`git pull`してから、手順1の`npx wrangler deploy`をもう一度実行します。
シークレットはそのまま残ります。
