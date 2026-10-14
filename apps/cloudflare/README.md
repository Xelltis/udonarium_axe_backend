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

新しく置くPUTは、送信元（IPv6は/64ごと）ごとに1分100件までです。
すでに置いてあるものへのPUTは数えません。

受け付ける形式は先頭のバイトで判定し、宣言されたContent-Typeは見ません。

| 種類 | 形式                                  | 上限  |
| ---- | ------------------------------------- | ----- |
| 画像 | PNG・JPEG・GIF・BMP・WebP・AVIF・HEIC | 2MiB  |
| 音声 | MP3・WAV・Ogg・FLAC・M4A・AAC         | 10MiB |

SVGは中にスクリプトを書けるので受け付けません。
MP4やMOVの動画も、M4Aと同じ入れ物ですが受け付けません。
受け付けなかった画像は、これまでどおりP2Pで配られます。

### キャッシュと保持期間

GETの応答は`Cache-Control: public, max-age=…, immutable`で返します。
`max-age`は7日か、保持期間の残りの短いほうです。
キャッシュに残った版が、バケットから消えたあとまで「ある」と答えないようにするためです。

保持期間（`ASSET_RETENTION_DAYS`）を過ぎたものは、バケットから消える前でも`404`を返します。
アップロードした人が次に部屋を読み込んだとき、HEADが`404`になるので上げ直され、保持期間もそこから数え直します。

同じデータセンターからの2回目以降のGETは、[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)から返し、R2を読みません。
Cache APIは`*.workers.dev`では効かないので、本番はカスタムドメインに置いてください。
R2を読むGETとHEADは、送信元ごとに1分600件までです。

### エラー

本文は`{"error": "<コード>"}`の形です。

| 状態 | コード                | 起きるとき                                            |
| ---- | --------------------- | ----------------------------------------------------- |
| 400  | `invalid-id`          | 名前が64文字の小文字16進でない                        |
| 400  | `hash-mismatch`       | 本文のハッシュが名前と合わない                        |
| 403  | `origin-not-allowed`  | PUTのOriginが許可リストにない                         |
| 404  | `not-found`           | その名前の中身が置かれていないか、保持期間を過ぎた    |
| 411  | `length-required`     | PUTに`Content-Length`がない                           |
| 412  | `precondition-failed` | GETの`If-Match`か`If-Unmodified-Since`に合わない      |
| 413  | `too-large`           | 種類ごとの上限を超えている                            |
| 415  | `unsupported-type`    | 受け付ける画像でも音声でもない                        |
| 429  | `rate-limited`        | アップロードかR2の読み出しが、1分あたりの上限を超えた |
| 500  | `config-invalid`      | 環境変数が足りないか、形が違う                        |
| 500  | `internal-error`      | それ以外の失敗                                        |

`config-invalid`のときは、足りない設定の名前がWorkerのログに出ます。

## セットアップ

Cloudflareのアカウントと、`npx wrangler login`でのログインが要ります。

1. バケットを作ります。

   ```sh
   npx wrangler r2 bucket create udonarium-axe-assets
   ```

2. 保持期間を決めます。次の例では、置いてから30日で消します。

   ```sh
   npx wrangler r2 bucket lifecycle add udonarium-axe-assets expire-30d --expire-days 30
   ```

   `wrangler.jsonc`の`ASSET_RETENTION_DAYS`も同じ日数にします。

3. `wrangler.jsonc`の`ACCESS_CONTROL_ALLOW_ORIGIN`に、アプリを配信しているOriginを書きます。
   複数あるときはカンマで区切ります。

4. デプロイします。

   ```sh
   npm ci
   npm run deploy
   ```

   キャッシュを効かせるため、Workerにはカスタムドメインを付けてください。

アプリ側の`config.json`には、このWorkerのURLを`assets.url`として書きます。

Workerを呼んだ回数そのものは、Workerの中では減らせません。
読み出しを繰り返されるのが心配なら、カスタムドメインのゾーンにWAFのレート制限ルールを足してください。

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
