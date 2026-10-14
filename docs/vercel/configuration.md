# Vercel版の設定項目

Vercel版は、Vercelのプロジェクトに設定した環境変数を読みます。
環境変数は、Vercelのプロジェクトの「Settings → Environment Variables」で足したり変えたりできます。

## 項目

| 名前                          | 必須 | 既定値  | 内容                                                                  |
| ----------------------------- | :--: | ------- | --------------------------------------------------------------------- |
| `SKYWAY_APP_ID`               |  ✅  | —       | SkyWayのアプリケーションID                                            |
| `SKYWAY_SECRET`               |  ✅  | —       | SkyWayのシークレットキー。トークンの署名に使う                        |
| `ACCESS_CONTROL_ALLOW_ORIGIN` |  ✅  | —       | 受けるOrigin。カンマ区切りで複数書ける                                |
| `SKYWAY_UDONARIUM_LOBBY_SIZE` |      | `3`     | ロビーの数（1以上の整数）。[トークン発行のしくみ](/token/#ロビーの数) |
| `SKYWAY_TOKEN_TTL_SECONDS`    |      | `86400` | 発行するトークンの有効期間（秒）。`60`（1分）〜`604800`（7日）        |

### `ACCESS_CONTROL_ALLOW_ORIGIN`

Axeを配信しているページのOriginを書きます。

```text
https://axe.example.com
https://axe.example.com,https://www.axe.example.com
```

- スキーム（`https://`）・ホスト名・ポートがすべて一致したときだけ通します。パスや末尾の`/`の違いは見ません。
- 空にすると、どのOriginも通しません。
- `*`と書くと、すべてのOriginを許可します。試すときだけにしてください。

### `SKYWAY_TOKEN_TTL_SECONDS`

トークンの有効期間です。
Axeは部屋に入るときにトークンを受け取り、そのあいだSkyWayにつながり続けます。
既定の24時間で困ることはほとんどありません。
短くすると、漏れたトークンが使える時間を縮められます。

範囲の外の値や、数字でない値を入れると、すべてのリクエストに`CONFIG_INVALID`を返します。

## 変えた値を効かせる

Vercelでは、環境変数を変えても、すでに動いているデプロイには反映されません。
変えたあとは、「Deployments」から最新のデプロイを選び、**Redeploy**を押してください。

## 手元で動かすとき

開発用に手元で動かすときは、Vercelに設定した環境変数を取ってこられます。

```sh
cd apps/vercel
npm ci
npm run env     # vercel env pull で .env を作る
npm start       # vercel dev（http://localhost:3000）
```

`.env`はGitに入らないようにしてあります。
