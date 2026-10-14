# udonarium-axe-backend（Cloudflare版）

Udonarium Axeの画像と音声を、中身のSHA-256を名前にしてR2に置くWorkerです。
同じ画像は何度上げても1つしか置かれず、卓の参加者はP2Pの代わりにここから受け取ります。
部屋のサーバー（Durable Objects）も、今後このWorkerに足します。

## エンドポイント

| メソッド | パス                 | 内容                                           |
| -------- | -------------------- | ---------------------------------------------- |
| `HEAD`   | `/v1/assets/:sha256` | 置かれているかを返す                           |
| `GET`    | `/v1/assets/:sha256` | 中身を返す。どのページからでも読める           |
| `PUT`    | `/v1/assets/:sha256` | 置く。許可したOriginからのリクエストだけ受ける |

`:sha256`は中身のSHA-256を小文字の16進で書いた64文字です。
PUTでは、本文のハッシュがこの名前と合わなければ置きません。

受け付ける形式は先頭のバイトで判定し、宣言されたContent-Typeは見ません。

| 種類 | 形式                                  | 上限  |
| ---- | ------------------------------------- | ----- |
| 画像 | PNG・JPEG・GIF・BMP・WebP・AVIF・HEIC | 2MiB  |
| 音声 | MP3・WAV・Ogg・FLAC・M4A・AAC         | 10MiB |

SVGは中にスクリプトを書けるので受け付けません。
受け付けなかった画像は、これまでどおりP2Pで配られます。

### エラー

本文は`{"error": "<コード>"}`の形です。

| 状態 | コード                | 起きるとき                                       |
| ---- | --------------------- | ------------------------------------------------ |
| 400  | `invalid-id`          | 名前が64文字の小文字16進でない                   |
| 400  | `hash-mismatch`       | 本文のハッシュが名前と合わない                   |
| 403  | `origin-not-allowed`  | PUTのOriginが許可リストにない                    |
| 404  | `not-found`           | その名前の中身が置かれていない                   |
| 411  | `length-required`     | PUTに`Content-Length`がない                      |
| 412  | `precondition-failed` | GETの`If-Match`か`If-Unmodified-Since`に合わない |
| 413  | `too-large`           | 種類ごとの上限を超えている                       |
| 415  | `unsupported-type`    | 受け付ける画像でも音声でもない                   |
| 429  | `rate-limited`        | 同じIPからのアップロードが1分に100件を超えた     |
| 500  | `config-invalid`      | 環境変数が足りないか、形が違う                   |
| 500  | `internal-error`      | それ以外の失敗                                   |

`config-invalid`のときは、足りない設定の名前がWorkerのログに出ます。

## セットアップ

Cloudflareのアカウントと、`npx wrangler login`でのログインが要ります。

1. バケットを作ります。

   ```sh
   npx wrangler r2 bucket create udonarium-axe-assets
   ```

2. 保持期間を決めます。次の例では、置いてから30日で消します。
   消えた画像は、使う人が次に部屋を読み込んだときにまた上がります。

   ```sh
   npx wrangler r2 bucket lifecycle add udonarium-axe-assets expire-30d --expire-days 30
   ```

3. `wrangler.jsonc`の`ACCESS_CONTROL_ALLOW_ORIGIN`に、アプリを配信しているOriginを書きます。
   複数あるときはカンマで区切ります。

4. デプロイします。

   ```sh
   npm ci
   npm run deploy
   ```

アプリ側の`config.json`には、このWorkerのURLを`assets.url`として書きます。

## 開発

```sh
npm ci
npm run dev        # http://localhost:8787 で起動
npm test           # Workersのランタイム（workerd）の中でテストする
npm run lint
npm run typecheck
```

テストは`@cloudflare/vitest-pool-workers`が持つwranglerとworkerdで動きます。
`npm run dev`と`npm run deploy`も同じランタイムで動くよう、`wrangler`はそのwranglerと同じ版に固定しています。
上げるときは、`@cloudflare/vitest-pool-workers`が使う版に合わせてください（CIで確かめます）。
