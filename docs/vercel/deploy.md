# Vercel版をデプロイする（トークン発行）

SkyWay版のAxeで遊ぶためのトークン発行サーバーを、Vercelに置く手順です。
サーバーを持っていなくても、ブラウザの操作だけで進められます。
かかる時間は、アカウント作りを含めて30分ほどです。

部屋のサーバー（サーバー版）としてVercelに置くときは、[部屋のサーバーとして置く](/vercel/rooms)を見てください。

::: info Vercelの画面は英語です
Vercelの画面は英語だけで、日本語に切り替えられません。
このページでは、ボタンやメニューの名前を、画面の表示のまま英語で書きます。
ブラウザの翻訳を使うと名前が変わるので、見比べるときは翻訳を切ってください。
:::

## 0. 用意するもの

- GitHubのアカウント（→ [設置の準備](/guide/prepare#githubのアカウントを作る)）
- SkyWayのアプリケーションIDとシークレットキー（→ [SkyWayのアプリを作る](/guide/skyway)）
- AxeのOrigin（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）

## 1. Vercelのアカウントを作る

すでにVercelのアカウントがあれば、ログインして手順2に進みます。

1. [Vercelの登録ページ](https://vercel.com/signup)を開きます。
2. プランを尋ねられたら、個人で使う無料のプラン（**Hobby**）を選び、名前を入れて進みます。
3. **Continue with GitHub**を押します。
4. GitHubのログインの画面が出たらログインし、VercelにGitHubのアカウントを使わせてよいかを尋ねられたら、**Authorize Vercel**を押します。

これで、VercelとGitHubがつながります。
次からは、同じGitHubのアカウントでVercelにログインします。

::: warning 無料のプラン（Hobby）は個人の非商用だけ
Hobbyは、個人が自分のために使うためのプランです。
広告を載せる、お金を受け取って運営するなど、誰かの収入につながる使いかたはできません。
団体での運用や商用のときは、[Vercelのプランの説明](https://vercel.com/docs/plans/hobby)を確かめてください。
:::

## 2. Deployボタンを押す

下のボタンを押します。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

Vercelの新しいプロジェクトを作る画面が開きます。
このボタンは、このリポジトリの`apps/vercel`だけを、あなたのGitHubに新しいリポジトリとして複製し、そこからVercelにデプロイします。
このリポジトリそのものは変わりません。

## 3. 複製先のリポジトリを決める

**Create Git Repository**の欄で、複製先を決めます。

1. Gitのサービスを尋ねられたら、**GitHub**を選びます。
2. 複製先のアカウントには、自分の個人のアカウントを選びます。無料のプランでは、GitHubの組織（Organization）の非公開リポジトリからはデプロイできません。
3. リポジトリの名前には、`my-udonarium-backend-vercel`が入っています。そのままで構いません。身内用と公開用など、2つ以上置くときは、名前を変えます。
4. 非公開（private）のリポジトリにするかを選ぶ欄があります。どちらでも動きます。迷ったら非公開のままにします。
5. **Create**を押します。

## 4. 環境変数を入れる

続いて、環境変数（サーバーに渡す設定）を入れる欄が3つ出ます。

| 名前                          | 入れる値                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `SKYWAY_APP_ID`               | SkyWayのアプリケーションID                                                    |
| `SKYWAY_SECRET`               | SkyWayのシークレットキー                                                      |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | AxeのOrigin（例：`https://axe.example.com`）。2つ以上あるときはカンマで区切る |

- 値は、コピーして貼り付けます。前後に空白や改行が入らないように気をつけてください。
- Originの末尾には`/`を付けません。パス（`/udonarium/`など）も付けません。

ほかの設定（トークンの有効期間、ロビーの数）は、あとから足せます。
ここでは入れなくて構いません（→ [設定項目](/vercel/configuration)）。

## 5. デプロイする

**Deploy**を押します。
ビルドが始まり、1〜2分ほどで終わります。

終わると、デプロイできたことを知らせる画面が出ます。
そこからプロジェクトの画面（ダッシュボード）に進みます。

ビルドが失敗したときは、画面に出るログの最後の数行を見てください。
環境変数の欄を空のまま進めた、などの原因が書いてあります。

## 6. サーバーのURLを控える

プロジェクトの画面の最初のページ（Overview）に、本番のデプロイと、そのドメインが出ています。
`my-udonarium-backend-vercel.vercel.app`のような名前です。
同じ名前がすでに使われていると、後ろに文字が足されることがあるので、画面に出ているとおりに控えてください。

このドメインの前に`https://`を付けたものが、**トークン発行サーバーのURL**です。
このあとの手順では、`https://my-udonarium-backend-vercel.vercel.app`として書きます。

## 7. 動いているか確かめる

ブラウザで、次のURLを開きます。

```text
https://my-udonarium-backend-vercel.vercel.app/
```

次のように出れば、サーバーは動いています。

```json
{ "message": "Hello udonarium-backend-vercel!" }
```

続いて、環境変数が読めているかを確かめます。
次のURLを開きます。

```text
https://my-udonarium-backend-vercel.vercel.app/v1/status
```

| 出たもの                    | 意味                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ORIGIN_REQUIRED`を含む文字 | 正しく動いています。ブラウザで直接開くとOriginが付かないので、サーバーが断っています。Axeから使うときは通ります |
| `CONFIG_INVALID`を含む文字  | 環境変数が足りないか、形が違います。[設定を直す](#設定を直す)を見てください                                     |

ターミナルが使えるなら、Originを付けて確かめることもできます（→ [設置の準備](/guide/prepare#ターミナルから確かめる-使える人だけ)）。
`OK`と出れば成功です。

```sh
curl -H "Origin: https://axe.example.com" https://my-udonarium-backend-vercel.vercel.app/v1/status
```

トークンが発行できるかは、Macのターミナルで次のように確かめられます。
`{"token":"eyJ..."}`が返れば、Axeから使えます。

```sh
curl -X POST https://my-udonarium-backend-vercel.vercel.app/v1/skyway/tokens \
  -H "Origin: https://axe.example.com" \
  -H "Content-Type: application/json" \
  -d '{"formatVersion":1,"channelName":"test-room","peerId":"test-peer"}'
```

## 8. Axeにつなぐ

Axeを配信している場所の`assets/config.json`を開き、`backend.url`に手順6のURLを書きます。
書きかたは[設置の準備](/guide/prepare#テキストファイルを書く)にあります。

```json
{
  "backend": {
    "url": "https://my-udonarium-backend-vercel.vercel.app"
  }
}
```

書き換えた`config.json`を配信先に置き直したら、Axeを開き、部屋を作ります。
ほかのブラウザ（または別の人）から同じ部屋に入れれば、完成です。
`config.json`のほかの項目は、[Axe側の設定](/guide/client-config)にあります。

## 設定を直す

環境変数は、あとから足したり直したりできます。

1. [Vercelのダッシュボード](https://vercel.com/dashboard)で、プロジェクトを開きます。
2. 左のサイドバーの**Environment Variables**を開きます。
3. 直すときは、その変数の行の右の **…** から**Edit**を選びます。足すときは、上の欄に**Name**と**Value**を入れます。
4. 値を見せない種類（**Secret**）と、あとから見られる種類（**Config**）を選ぶ欄があります。`SKYWAY_SECRET`は**Secret**にします。
5. **Save**を押します。

環境変数を変えても、いま動いているデプロイには反映されません。
変えたあとは、デプロイし直します。

1. 左のサイドバーの**Deployments**を開きます。
2. いちばん上（最新）のデプロイの右の **…** から、**Redeploy**を選びます。
3. 確かめる画面が出たら、**Redeploy**を押します。

## 独自ドメインで公開する

`*.vercel.app`のURLのままでも使えます。
自分のドメイン（例：`backend.example.com`）で公開したいときは、プロジェクトの**Settings**の**Domains**から足します。
画面に、ドメインの管理元（お名前.comなど）でDNSに足す値が出るので、そのとおりに設定します。
足し終えたら、Axeの`backend.url`も新しいURLに書き換えます。

## 更新するとき

Deployボタンで作ったリポジトリは、このリポジトリとは別のものです。
このリポジトリが新しくなっても、あなたのサーバーは自動では変わりません。
新しい版を取り込むには、次のどちらかをします。

- このリポジトリの`apps/vercel`の変更を、自分のリポジトリに取り込む。自分のリポジトリに変更が入ると、Vercelが自動でデプロイし直します。
- もう一度Deployボタンで新しいプロジェクトを作り、環境変数を入れ直して、Axeの`backend.url`を新しいURLに差し替える。

## うまくいかないとき

[Vercel版で困ったとき](/vercel/troubleshooting)を見てください。
