# Vercel版をデプロイする

Deployボタンを使って、Vercel版を自分のVercelアカウントに置くまでの手順です。

## 1. Deployボタンを押す

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

ボタンを押すと、Vercelの「新しいプロジェクト」の画面が開きます。
このリポジトリの`apps/vercel`だけが、あなたのGitHubに新しいリポジトリとして複製されます。

## 2. リポジトリの名前を決める

1. 複製先のGitHubアカウントを選びます。
2. リポジトリの名前を決めます。既定は`my-udonarium-backend-vercel`です。身内用と公開用など、複数置くときは名前を変えます。
3. 非公開（Private）にするかを選びます。どちらでも動きます。

## 3. 環境変数を入れる

次の3つを入れます。

| 名前                          | 入れる値                                                 |
| ----------------------------- | -------------------------------------------------------- |
| `SKYWAY_APP_ID`               | SkyWayのアプリケーションID                               |
| `SKYWAY_SECRET`               | SkyWayのシークレットキー                                 |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | Axeを配信しているOrigin（例：`https://axe.example.com`） |

ほかにも、トークンの有効期間とロビーの数を変えられます。
あとから足すこともできるので、ここでは入れなくて構いません。
詳しくは[設定項目](/vercel/configuration)にあります。

## 4. デプロイする

**Deploy**を押し、ビルドが終わるのを待ちます（1〜2分ほど）。
完了すると、`https://my-udonarium-backend-vercel.vercel.app`のようなURLが出ます。
これがトークン発行サーバーのURLです。

## 5. 動いているか確かめる

ターミナルで次を実行します。
Vercel版は`/v1/`の下でOriginを確かめるので、`Origin`ヘッダーを付けます。

```sh
curl -H "Origin: https://axe.example.com" https://my-udonarium-backend-vercel.vercel.app/v1/status
```

`OK`と表示されれば成功です。

トークンが発行できるかは、次で確かめられます。

```sh
curl -X POST https://my-udonarium-backend-vercel.vercel.app/v1/skyway/tokens \
  -H "Origin: https://axe.example.com" \
  -H "Content-Type: application/json" \
  -d '{"formatVersion":1,"channelName":"test-room","peerId":"test-peer"}'
```

## 6. Axeにつなぐ

Axeの`assets/config.json`の`backend.url`に、手順4のURLを書きます。

```json
{
  "backend": {
    "url": "https://my-udonarium-backend-vercel.vercel.app"
  }
}
```

詳しくは[Axe側の設定](/guide/client-config)を見てください。

## 独自ドメインで公開する

`*.vercel.app`のURLのままでも使えます。
自分のドメイン（例：`backend.example.com`）で公開したいときは、Vercelのプロジェクトの「Settings → Domains」から足します。
足したら、Axeの`backend.url`も新しいURLに書き換えます。

## 更新するとき

Deployボタンで作ったリポジトリは、このリポジトリとは別のものです。
新しい版を取り込むには、次のどちらかをします。

- このリポジトリの`apps/vercel`の変更を、自分のリポジトリに手で取り込む
- もう一度Deployボタンで新しいプロジェクトを作り、環境変数を入れ直して、Axeの`backend.url`を差し替える
