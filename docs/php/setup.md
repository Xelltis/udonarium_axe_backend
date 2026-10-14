# PHP版を設置する

レンタルサーバーにPHP版を置き、Axeから使えるようにするまでの手順です。
FTPでファイルを置ける人なら、コマンドを使わずに進められます。

## 0. 用意するもの

- SkyWayのアプリケーションIDとシークレットキー（→ [クイックスタートの手順1](/guide/quickstart#_1-skywayのアプリを作る)）
- PHP 8.3以上が動くレンタルサーバーと、そのFTPの接続先
- Axeを配信しているURL（例：`https://axe.example.com`）

## 1. 置き場所を決める

トークン発行サーバーを置くURLを決めます。
次のどちらでも動きます。

| 置き方               | 例                             | Axeの`backend.url`に書く値    |
| -------------------- | ------------------------------ | ----------------------------- |
| サブドメインの直下   | `https://backend.example.com/` | `https://backend.example.com` |
| サブディレクトリの中 | `https://example.com/backend/` | `https://example.com/backend` |

## 2. 配布物を取ってくる

1. [リリース](https://github.com/Xelltis/udonarium_axe_backend/releases/latest)のページを開きます。
2. **Assets**の中の`udonarium-axe-backend-<版>.zip`をダウンロードします。
3. 手元で展開します。

::: tip 「Source code」のzipではありません
同じページにある「Source code (zip)」は開発用のファイル一式です。
設置には`udonarium-axe-backend-<版>.zip`のほうを使ってください。
:::

## 3. `.env`を作る

展開したフォルダの中の`.env.example`をコピーして、名前を`.env`にします。
テキストエディターで開き、次の値を書き換えます。

```dotenv
SKYWAY_APP_ID="SkyWayのアプリケーションID"
SKYWAY_SECRET="SkyWayのシークレットキー"
SKYWAY_UDONARIUM_LOBBY_SIZE=3
ACCESS_CONTROL_ALLOW_ORIGIN="https://axe.example.com"
```

- 値は`"`（ダブルクォート）で囲んでおくと安全です。囲まないと、`#`から後ろがコメントとして切り捨てられます。
- `ACCESS_CONTROL_ALLOW_ORIGIN`には、Axeを配信しているOriginを書きます。末尾に`/`は付けません。複数あるときはカンマで区切ります。

それぞれの値の意味は[設定項目](/php/configuration)にあります。

::: tip Windowsのエクスプローラーで`.env`が作れないとき
名前の先頭が`.`のファイルは、エクスプローラーでは作りにくいことがあります。
テキストエディターの「名前を付けて保存」で、ファイル名を`.env`、種類を「すべてのファイル」にして保存してください。
:::

## 4. FTPでアップロードする

展開したフォルダの**中身**を、手順1で決めた場所にアップロードします。
フォルダごとではなく、`index.php`がその場所の直下に来るようにします。

```text
（公開する場所。例：public_html/backend/）
 ├─ .env           ← 手順3で作ったもの
 ├─ .htaccess
 ├─ index.php
 ├─ src/
 └─ …
```

::: warning `.htaccess`と`.env`を忘れずに
名前が`.`で始まるファイルは、FTPクライアントの設定によっては表示もアップロードもされません。
「隠しファイルを表示する」をオンにして、`.htaccess`と`.env`が上がっているか確かめてください。
:::

## 5. パーミッションを設定する

FTPクライアントでファイルやフォルダを右クリックし、「パーミッション」や「属性の変更」から設定します。

| 対象                                | パーミッション |
| ----------------------------------- | -------------- |
| フォルダ（`src/`など）              | `755`          |
| ファイル（`.php`、`.htaccess`など） | `644`          |
| `.env`                              | `600`          |

::: danger `.env`は必ず`600`に
`.env`にはSkyWayのシークレットキーが書いてあります。
`644`のままだと、同じサーバーを使っているほかの利用者から読まれるおそれがあります。
:::

SSHが使えるサーバーなら、設置したフォルダで次のコマンドを実行すれば一括して設定できます。

```sh
find . -type d -exec chmod 755 {} +
find . -type f -exec chmod 644 {} +
chmod 600 .env
```

## 6. 動いているか確かめる

ブラウザで`/v1/status`を開きます。

```text
https://backend.example.com/v1/status
```

`OK`と表示されれば成功です。
うまくいかないときは、[困ったとき](/php/troubleshooting)を見てください。

トークンが発行できるかは、次のコマンドで確かめられます。
`Origin`には、`.env`に書いたOriginを使います。

```sh
curl -X POST https://backend.example.com/v1/skyway2023/token \
  -H "Origin: https://axe.example.com" \
  -H "Content-Type: application/json" \
  -d '{"formatVersion":1,"channelName":"test-room","peerId":"test-peer"}'
```

`{"token":"eyJ..."}`が返れば、Axeから使えます。

## 7. Axeにつなぐ

Axeの`assets/config.json`の`backend.url`に、このサーバーのURLを書きます。

```json
{
  "backend": {
    "url": "https://backend.example.com"
  }
}
```

詳しくは[Axe側の設定](/guide/client-config)を見てください。

## もっと安全にしたいとき

SSHが使えて、公開フォルダの外にファイルを置けるサーバーなら、`.env`を公開フォルダの外に置けます。

- **公開フォルダの1つ上に置く**：PHP版は、`index.php`と同じ場所に`.env`が無ければ、1つ上のフォルダの`.env`を読みます。
- **好きな場所に置く**：`.htaccess`に`SetEnv ENV_PATH /home/user/secret/.env`のように書くと、その場所の`.env`を最初に読みます。

## 更新するとき

1. 新しい版のzipを取ってきて展開します。
2. `.env`以外のファイルを、上書きでアップロードします。
3. `/v1/status`で`OK`が返るかを確かめます。

`.env`は上書きしないでください。
新しい版で設定項目が増えたときは、[リリースノート](https://github.com/Xelltis/udonarium_axe_backend/releases)と`.env.example`を見比べて、足りない項目を書き足します。
