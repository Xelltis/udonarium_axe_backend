# SkyWay版の設定項目

トークン発行サーバー（PHP版とVercel版）の設定を説明します。
PHP版は`.env`というテキストファイルから、Vercel版はVercelのプロジェクトの環境変数から、同じ名前の設定を読みます。

## 項目

| 名前                          | 必須 | 既定値  | PHP版 | Vercel版 | 内容                                                           |
| ----------------------------- | :--: | ------- | :---: | :------: | -------------------------------------------------------------- |
| `SKYWAY_APP_ID`               |  ○   | —       |   ○   |    ○     | SkyWayのアプリケーションID                                     |
| `SKYWAY_SECRET`               |  ○   | —       |   ○   |    ○     | SkyWayのシークレットキー。トークンの署名に使う                 |
| `ACCESS_CONTROL_ALLOW_ORIGIN` |  ○   | —       |   ○   |    ○     | トークンの発行を受けるAxeのOrigin。カンマ区切りで複数書ける    |
| `SKYWAY_UDONARIUM_LOBBY_SIZE` |      | `3`     |   ○   |    ○     | ロビーの数（1以上の整数）                                      |
| `SKYWAY_TOKEN_TTL_SECONDS`    |      | `86400` |       |    ○     | 発行するトークンの有効期間（秒）。`60`（1分）〜`604800`（7日） |

PHP版のトークンの有効期間は、24時間で変えられません。

### `ACCESS_CONTROL_ALLOW_ORIGIN`

Axeを配信しているページのOriginを書きます（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）。

```text
https://axe.example.com
https://axe.example.com,https://www.axe.example.com
```

- スキーム（`https://`）・ホスト名・ポートがすべて一致したときだけ通します。
- 空にすると、どのOriginからのトークンの発行も断ります。
- `*`と書くと、すべてのOriginを許可します。試すときだけにしてください。ほかのサイトに置かれたAxeからも、あなたのSkyWayのアプリケーションが使えてしまい、その利用量はあなたのFreeプランに数えられます。
- PHP版では、末尾に`/`を付けないでください。PHP版は、ここに書いた文字列をそのままブラウザに返すので、`/`が付いているとブラウザが「Originが違う」と判断して通信を止めます。Vercel版は、パスや末尾の`/`の違いを見ません。

### `SKYWAY_UDONARIUM_LOBBY_SIZE`

ロビー（部屋の一覧を見るためのチャンネル）の数です。
同時にロビーにいる人が数百人を超えるときに増やします。
同じSkyWayのアプリケーションを使うトークン発行サーバーどうしでは、同じ値にそろえてください（→ [ロビーの数](/skyway/#ロビーの数)）。

### `SKYWAY_TOKEN_TTL_SECONDS`（Vercel版）

トークンの有効期間です。
Axeは部屋に入るときにトークンを受け取り、そのあいだSkyWayにつながり続けます。
既定の24時間で困ることは、ほとんどありません。
短くすると、漏れたトークンが使える時間を縮められます。
範囲の外の値や、数字でない値を入れると、すべてのリクエストに`CONFIG_INVALID`を返します。

## PHP版の`.env`

### 書きかた

`.env`には、`名前=値`を1行に1つ書きます。
`#`で始まる行は、説明（コメント）です。

```dotenv
# SkyWayのアプリケーションID
SKYWAY_APP_ID="..."
```

値は`"`（ダブルクォート）で囲んでください。
囲まない値に`;`が入っていると、`;`から後ろが切り捨てられます。
囲んでおけば、`;`も`#`もそのまま読みます。

### 探す順番

PHP版は、次の順に`.env`を探し、最初に見つかったものを読みます。

1. 環境変数`ENV_PATH`に書かれた場所（`.htaccess`に`SetEnv ENV_PATH /home/user/secret/.env`のように書く）
2. `index.php`と同じフォルダの`.env`
3. `index.php`の1つ上のフォルダの`.env`

どこにも無いときや、必須の値が欠けているときは、すべてのリクエストに`500`を返します。
原因は、PHPのエラーログに出ます。

3番目は、`index.php`をドキュメントルートの直下に置いたときのためのものです。
サブディレクトリやサブドメインに置いたときは、`index.php`の1つ上のフォルダは公開フォルダの中なので、そこに`.env`を置かないでください（→ [もっと安全にしたいとき](/skyway/php#もっと安全にしたいとき)）。

### `.htaccess`が断るもの

付属の`.htaccess`は、次のものへのWebからのアクセスを断ります。
`.htaccess`を書き換えるときは、これらが見えるようにならないよう気をつけてください。

- 名前が`.`で始まるファイルとフォルダ（`.env`、`.git`など）。ただし、SSLの証明書の発行に使う`.well-known/`は通す
- `composer.json`、`phpunit.xml`、`Dockerfile`など、開発用のファイル
- `vendor/`、`tests/`、`bin/`、`docs/`などのフォルダ

## Vercel版の環境変数

環境変数は、Vercelのプロジェクトの**Environment Variables**で足したり変えたりします。
変えたあとは、デプロイし直すまで反映されません（→ [Vercelに置く](/skyway/vercel#設定を直す)）。

部屋のサーバーも同じプロジェクトで動かすときは、[サーバー版の設定項目](/server/configuration)の項目も入れます。
SkyWayの項目を入れずに部屋のサーバーだけを使うと、SkyWayの経路（`/v1/status`、`/v1/skyway/*`、`/v1/skyway2023/*`）は`CONFIG_INVALID`を返します。

### 手元で動かす

```sh
cd apps/vercel
npm ci
npm run env     # vercel env pull で .env.local を作る
npm start       # vercel dev（http://localhost:3000）
```

`npm run env`は、Vercelのプロジェクトに入れた環境変数を取ってきます。
種類を**Secret**にした値は取ってこられないことがあるので、そのときは`.env.local`に手で書きます。
`.env`と`.env.local`は、Gitに入らないようにしてあります。
