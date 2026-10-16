# Cloudflare版をデプロイする

Cloudflare版（部屋のサーバー）を自分のCloudflareアカウントに置き、Axeから使えるようにするまでの手順です。
いちばん手軽なのは、Deploy to Cloudflareボタンを使う方法です。

## 1. R2を使い始める（アカウントに一度だけ）

CloudflareのR2は、使う前にアカウントで申し込みが要ります。
無料枠があり、その範囲なら料金はかかりませんが、申し込みには支払い方法の登録が要ります。

1. [Cloudflareのダッシュボード](https://dash.cloudflare.com/)にログインします。
2. 左のメニューから「Storage & databases → R2」を開きます。
3. 案内に従って、R2の申し込み（Purchase R2 / Get started）を済ませます。

バケットは、このあとのデプロイで自動で作られるので、ここでは作りません。

::: warning 申し込みを忘れるとデプロイが失敗します
R2を使い始めていないアカウントでは、バケットを作れずにデプロイが止まります。
エラーに「Please enable R2 through the Cloudflare Dashboard」と出たら、この手順を済ませてからやり直してください。
:::

## 2. Deployボタンを押す

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Xelltis/udonarium_axe_backend/tree/main/apps/cloudflare)

ボタンを押すと、Cloudflareのデプロイ画面が開きます。
このリポジトリの`apps/cloudflare`だけが、あなたのGitHub（またはGitLab）に新しいリポジトリとして複製され、そこからデプロイされます。

画面では、次のものを決めます。

| 項目                          | 入れるもの                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Gitのアカウントとリポジトリ名 | 複製先。身内用と公開用など、複数置くときは名前を変える                       |
| Workerの名前                  | 例：`udonarium-axe-backend`。R2のバケットは「<この名前>-assets」で作られる   |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | Axeを配信しているOrigin（例：`https://axe.example.com`）。複数はカンマ区切り |
| `ROOM_RETENTION_HOURS`        | 最後の1人が抜けてから部屋を消すまでの時間。既定は`24`                        |
| `DISCORD_CLIENT_ID`           | ログインに使うDiscordのアプリのClient ID                                     |
| `DISCORD_CLIENT_SECRET`       | 同じアプリのClient Secret                                                    |
| `SESSION_SECRET`              | トークンに署名する鍵。32文字以上の乱数（`openssl rand -base64 48`など）      |

ログインの3つは、そろえて入れるか、どれも入れないかのどちらかにします。
どれも入れなければ、ログインも部屋も、部屋のアセットも使えません。
Discordのアプリの作りかたは[ログインと役割](/cloudflare/login#ログインを使えるようにする)にあります。
アプリの**Redirects**に入れるURLはWorkerのURLから決まるので、先にアプリだけ作ってClient IDとClient Secretを入れ、デプロイしてURLが決まってから**Redirects**を足しても構いません。
**Redirects**は、Axeの`backend.url`に書くのと同じドメインで登録してください。手順3でカスタムドメインを付けるなら、そのドメインです。戻り先のURLはリクエストを受けたホスト名から作るので、`*.workers.dev`で登録したままカスタムドメインから使うと、Discordが`Invalid OAuth2 redirect_uri`を出します。

**Deploy**を押すと、リポジトリの複製、R2のバケットの作成、部屋のサーバー（Durable Objects）の作成、Workerのデプロイがまとめて行われます。
完了すると、`https://<Workerの名前>.<アカウントのサブドメイン>.workers.dev`のURLが出ます。

## 3. カスタムドメインを付ける

`*.workers.dev`のURLのままでも動きますが、**本番ではカスタムドメインを付けてください**。
CloudflareのCache APIは`*.workers.dev`では効かないので、そのままだと毎回R2から読むことになります。

1. ダッシュボードで「Workers & Pages」から、デプロイしたWorkerを開きます。
2. 「Settings → Domains & Routes」で**Add → Custom domain**を選びます。
3. `backend.example.com`のように、Cloudflareで管理しているドメインの下の名前を入れます。

カスタムドメインには、そのドメインのDNSをCloudflareで管理している必要があります。

::: warning cookieを使わないホスト名にする
Axeやログインの画面とは別の、このWorkerのためだけのホスト名にしてください。
置かれたSVGが万一文書として開かれても、そのホスト名のcookieを読ませないためです。
詳しくは[安全のしくみ](/cloudflare/security#svgはサンドボックスに入れて配る)にあります。
:::

## 4. Axeにつなぐ

Axeの`assets/config.json`で、`transport`を`"server"`にし、`backend.url`に手順3のURLを書きます。

```json
{
  "transport": "server",
  "backend": {
    "url": "https://backend.example.com"
  }
}
```

詳しくは[Axe側の設定](/guide/client-config#サーバー版で配信するとき)を見てください。

## 5. 動いているか確かめる

部屋の一覧を尋ねると、`{"rooms":[]}`のような答えが返ります。
`Origin`には、`ACCESS_CONTROL_ALLOW_ORIGIN`に書いたものを付けます。

```sh
curl -H "Origin: https://axe.example.com" https://backend.example.com/v1/rooms
```

サーバー版のAxeで部屋に入って画像を足し、開発者ツール（F12）の「ネットワーク」を見ると、次の流れが見えます。
どれも`/v1/rooms/<部屋の鍵>/assets/<SHA-256>`へのリクエストです。

1. 画像を足した人（GMかPL）のブラウザ：`HEAD`（`404`）のあと`PUT`（`201`）
2. ほかの参加者のブラウザ：`GET`（`200`）

ログインを置いたかは、次で確かめます。

```sh
curl -H "Origin: https://axe.example.com" https://backend.example.com/v1/auth/config
```

`{"providers":["discord"]}`が返れば、ログインと部屋が使えます。
`{"providers":[]}`なら、ログインの3つが入っていません。このままでは、部屋も部屋のアセットも使えません。
ログインそのものは、Axeから一度ログインしてみて確かめてください。

## 手元からwranglerでデプロイする

Deployボタンを使わずに、手元からデプロイすることもできます。

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

## 更新するとき

Deployボタンで作ったリポジトリは、このリポジトリとは別のものです。
Cloudflareは、複製したリポジトリに変更が入るたびに自動でデプロイし直します（Workers Builds）。
新しい版を取り込むには、このリポジトリの`apps/cloudflare`の変更を、複製したリポジトリに取り込んでください。

## 次に読むもの

- [設定項目](/cloudflare/configuration)
- [運用と料金](/cloudflare/operations)
- [困ったとき](/cloudflare/troubleshooting)
