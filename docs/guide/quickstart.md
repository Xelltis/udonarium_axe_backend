# クイックスタート

いちばん手軽な組み合わせ（Vercel版のトークン発行サーバー）で、SkyWay版のAxeが遊べるようになるまでの手順を、短くまとめたページです。
1つ1つの操作を詳しく知りたいときや、初めてサーバーを置くときは、[設置の準備](/guide/prepare)と[Vercel版をデプロイする](/vercel/deploy)を見てください。

SkyWayを使わないサーバー版は、Axe v1.68.0からベータとして使えます（→ [今後の計画](/guide/roadmap)）。
サーバー版で使うCloudflare版の手順は、[Cloudflare版をデプロイする](/cloudflare/deploy)にあります。

所要時間の目安は15分ほどです。

## 用意するもの

- [SkyWay](https://skyway.ntt.com/)のアカウント（無料で作れます）
- [Vercel](https://vercel.com/)のアカウント（GitHubのアカウントでログインできます）
- [GitHub](https://github.com/)のアカウント（Deployボタンがリポジトリを複製する先です）
- Axeを配信する場所と、そのURL（例：`https://axe.example.com`）

Axe本体の置きかたは、[Axeの利用ガイド](https://xelltis.github.io/udonarium_axe/guide/quickstart)にあります。
先にAxeを置く場所のURLを決めておくと、途中の設定で迷いません。

## 1. SkyWayのアプリを作る

[SkyWayのアプリを作る](/guide/skyway)の手順で、アプリケーションを1つ作り、**アプリケーションID**と**シークレットキー**を控えます。
シークレットキーは、人に見せないでください。

## 2. トークン発行サーバーをデプロイする

下のボタンを押すと、Vercelのデプロイ画面が開きます。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

1. GitHubのアカウントを選び、複製先のリポジトリ名を決めます（そのままでも構いません）。
2. 環境変数を3つ入れます。

   | 名前                          | 入れる値                                                  |
   | ----------------------------- | --------------------------------------------------------- |
   | `SKYWAY_APP_ID`               | 手順1のアプリケーションID                                 |
   | `SKYWAY_SECRET`               | 手順1のシークレットキー                                   |
   | `ACCESS_CONTROL_ALLOW_ORIGIN` | Axeを配信するURLのOrigin（例：`https://axe.example.com`） |

3. **Deploy**を押し、完了するまで待ちます。
4. 完了画面に出るURL（例：`https://my-udonarium-backend-vercel.vercel.app`）を控えます。これが**トークン発行サーバーのURL**です。

::: tip Originの書きかた
`https://axe.example.com`のように、スキームとホスト名（とポート）だけを書きます。
末尾の`/`やパス（`/play/`など）は付けません。
複数あるときは、カンマで区切ります。
:::

PHP版を使う場合は、この手順の代わりに[PHP版を設置する](/php/setup)を進めてください。

## 3. 動いているか確かめる

ブラウザで、手順2のURLの後ろに`/v1/status`を付けたもの（例：`https://my-udonarium-backend-vercel.vercel.app/v1/status`）を開きます。
`ORIGIN_REQUIRED`を含む文字が出れば、サーバーは環境変数を読めていて、正しく動いています（ブラウザで直接開くとOriginが付かないので、断られます）。
`CONFIG_INVALID`が出たら、環境変数が足りないか、形が違います（→ [設定を直す](/vercel/deploy#設定を直す)）。

ターミナルが使えるなら、Originを付けて確かめられます。
`OK`と表示されれば成功です。

```sh
curl -H "Origin: https://axe.example.com" https://my-udonarium-backend-vercel.vercel.app/v1/status
```

`ORIGIN_FORBIDDEN`が出たら、`Origin`の値と環境変数`ACCESS_CONTROL_ALLOW_ORIGIN`が一致しているかを確かめてください。

## 4. Axeに接続先を書く

Axeを配信している場所の`assets/config.json`に、手順2のURLを書きます。

```json
{
  "backend": {
    "url": "https://my-udonarium-backend-vercel.vercel.app"
  }
}
```

Axeを開いて部屋を作り、ほかのブラウザから入れれば完成です。
設定項目の詳しい意味は、[Axe側の設定](/guide/client-config)にあります。

## うまくいかないとき

- [よくある質問](/guide/faq)
- [PHP版で困ったとき](/php/troubleshooting) / [Vercel版で困ったとき](/vercel/troubleshooting) / [Cloudflare版で困ったとき](/cloudflare/troubleshooting)
