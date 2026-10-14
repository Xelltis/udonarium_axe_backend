# セットアップガイド

## 1. ファイルの配置

リポジトリをドキュメントルートに配置します。

```
/home/user/www/backend/   ← ドキュメントルート（index.php がここ）
```

## 2. `.env` の作成

```sh
cp .env.example .env
```

`.env.example` を参考に値を設定してください。

```dotenv
SKYWAY_APP_ID=your_skyway_app_id_here
SKYWAY_SECRET=your_skyway_secret_here
SKYWAY_UDONARIUM_LOBBY_SIZE=3
ACCESS_CONTROL_ALLOW_ORIGIN=https://your-udonarium-front.example.com
```

`.env` は `index.php` と同じディレクトリに配置します。`.htaccess` によりブラウザからの直接アクセスは遮断されます。

## 3. パーミッションの設定

FTP クライアントでファイルを右クリックし、「パーミッション」や「属性変更」からパーミッションを設定してください。

```
www/backend/                      755
├── .env                          600  ← 機密情報
├── .htaccess                     644
├── index.php                     644
└── src/                          755
    ├── .htaccess                  644
    ├── App.php                   644
    ├── Auth/                     755
    │   └── SkywayAuth.php        644
    ├── Config/                   755
    │   └── AppConfig.php         644
    ├── Http/                     755
    │   ├── Request.php           644
    │   ├── Response.php          644
    │   └── Router.php            644
    ├── Middleware/                755
    │   └── CorsMiddleware.php    644
    └── Util/                     755
        └── UrlUtils.php          644
```

| 対象                                  | パーミッション | FTP クライアントでの設定手順                           |
| ------------------------------------- | -------------- | ------------------------------------------------------ |
| ディレクトリ全般                      | `755`          | フォルダを右クリック →「パーミッション」→ `755` を入力 |
| `.php` / `.htaccess` 等の一般ファイル | `644`          | ファイルを右クリック →「パーミッション」→ `644` を入力 |
| `.env`                                | `600`          | `.env` を右クリック →「パーミッション」→ `600` を入力  |

> **重要:** `.env` は必ず `600` に設定してください。`644` のままだとサーバー上の他のユーザーから読み取られるリスクがあります。

<details>
<summary>SSH が使える場合</summary>

付属のスクリプトで一括設定できます。

```sh
bash bin/set-permissions.sh
```

または手動で実行：

```sh
find . -type d -exec chmod 755 {} +
find . -type f -exec chmod 644 {} +
chmod 600 .env
```

</details>

## 4. Apache の設定

本プロジェクトは `.htaccess` による URL 書き換えとアクセス制御に依存しています。ご利用のレンタルサーバーで `mod_rewrite` と `.htaccess`（`AllowOverride All`）が有効になっていることを確認してください。

> **重要:** `.htaccess` が利用できないサーバーでは、機密ファイルへのアクセス制御が機能しないため、本プロジェクトの使用は推奨しません。

## 5. 動作確認

```sh
curl https://your-backend.example.com/v1/status
# => OK
```
