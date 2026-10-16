# Vercelに置く（SkyWay版）

SkyWay版のAxeで遊ぶためのトークン発行サーバーを、Vercelに置く手順です。
サーバーを持っていなくても、ブラウザの操作だけで進められます。
かかる時間は、アカウント作りを含めて30分ほどです。

<Journey mode="skyway" here="vercel" />

Vercelの東京のリージョン（`hnd1`）で動くので、国内からの応答が速くなります。
部屋のサーバー（サーバー版）としてVercelに置くときは、[Vercelに置く（サーバー版）](/server/vercel)を見てください。

::: info Vercelの画面は英語です
Vercelの画面は英語だけで、日本語に切り替えられません。
このページでは、ボタンやメニューの名前を、画面の表示のまま英語で書きます。
ブラウザの翻訳を使うと名前が変わるので、見比べるときは翻訳を切ってください。
:::

## 0. 用意するもの

- GitHubのアカウント（→ [設置の準備](/guide/prepare#githubのアカウントを作る)）
- SkyWayのアプリケーションIDとシークレットキー（→ [SkyWayのアプリを作る](/skyway/app)）
- AxeのOrigin（→ [設置の準備](/guide/prepare#axeのoriginを確かめる)）

途中で、次の値を入れたり控えたりします。
パソコンの中にメモのファイルを1つ作り、そこに貼り付けながら進めると迷いません（→ [秘密の値の扱い](/guide/prepare#秘密の値の扱い)）。

| 値                         | 手に入れるところ                                   | 使う手順 |
| -------------------------- | -------------------------------------------------- | -------- |
| AxeのOrigin                | [設置の準備](/guide/prepare#axeのoriginを確かめる) | 手順4    |
| SkyWayのアプリケーションID | [SkyWayのアプリを作る](/skyway/app)                | 手順4    |
| SkyWayのシークレットキー   | [SkyWayのアプリを作る](/skyway/app)                | 手順4    |
| トークン発行サーバーのURL  | 手順6                                              | 手順7、8 |

## 1. Vercelのアカウントを作る

すでにVercelのアカウントがあれば、ログインして手順2に進みます。

1. [Vercelの登録ページ](https://vercel.com/signup)を開きます。
2. **Continue with GitHub**を押します。GoogleやメールアドレスでもVercelのアカウントは作れますが、GitHubで作ると、あとでGitHubとつなぐ手間が省けます。
3. GitHubのログインの画面が出たら、ログインします。
4. VercelにGitHubのアカウントを使わせてよいかを尋ねる画面が出たら、許可するボタンを押します。
5. プランを尋ねられたら、個人で使う無料のプラン（**Hobby**）を選び、名前を入れて進みます。

Vercelのダッシュボードが開けば、アカウントができています。
これで、VercelとGitHubがつながります。
次からは、同じGitHubのアカウントでVercelにログインします。

::: warning 無料のプラン（Hobby）は個人の非商用だけ
Hobbyは、個人が自分のために使うためのプランです。
広告を載せる、お金を受け取って運営するなど、誰かの収入につながる使いかたはできません。
団体での運用や商用のときは、[Vercelのプランの説明](https://vercel.com/docs/plans/hobby)を確かめてください。
:::

## 2. Deployボタンを押す

下のボタンを押します。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&envDescription=%E3%81%9D%E3%82%8C%E3%81%9E%E3%82%8C%E3%81%AE%E6%AC%84%E3%81%AB%E5%85%A5%E3%82%8C%E3%82%8B%E5%80%A4%E3%81%AF%E3%80%81Learn%20More%E3%81%8B%E3%82%89%E9%96%8B%E3%81%8F%E6%89%8B%E9%A0%86%E3%81%AE%E3%83%9A%E3%83%BC%E3%82%B8%E3%81%AB%E3%81%82%E3%82%8A%E3%81%BE%E3%81%99%E3%80%82&envLink=https%3A%2F%2Fxelltis.github.io%2Fudonarium_axe_backend%2Fskyway%2Fvercel%23_4-%E7%92%B0%E5%A2%83%E5%A4%89%E6%95%B0%E3%82%92%E5%85%A5%E3%82%8C%E3%82%8B&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

Vercelの新しいプロジェクトを作る画面（**New Project**）が開きます。
ログインしていないときは「Sign in to clone and deploy.」と出るので、**Continue with GitHub**を押してログインします。

<DeployMap kind="vercel-token" />

このボタンは、このリポジトリの`apps/vercel`だけを、あなたのGitHubに新しいリポジトリとして複製し、そこからVercelにデプロイします。
このリポジトリそのものは変わりません。

## 3. 複製先のリポジトリを決める

**New Project**の画面の、リポジトリを作るカードで、複製先を決めます。
カードには「Create a Git repository to easily update your project after deploying it.」と書いてあります。

1. **Git Providers**の中から、**GitHub**を押します。
2. **Git Scope**で、自分の個人のアカウントを選びます。無料のプランでは、GitHubの組織（Organization）の非公開リポジトリからはデプロイできません。
3. 自分のアカウントが出てこないときは、**Git Scope**の中の**Add GitHub Scope**を選びます。GitHubの画面が開くので、Vercelを入れる先に自分のアカウントを選び、**Install**を押します。
4. **Private Repository Name**の欄には、`my-udonarium-backend-vercel`が入っています。そのままで構いません。身内用と公開用など、2つ以上置くときは、名前を変えます。
5. 名前の欄の中のスイッチで、非公開（private）にするか公開にするかを選べます。最初は非公開になっています。どちらでも動くので、そのままにします。
6. **Create**を押します。

## 4. 環境変数を入れる

続いて、**Add Environment Variables**のカードに、環境変数（サーバーに渡す設定）を入れる欄が3つ出ます。
左の**Name**には名前が入っていて、変えられません。
右の**Value**に値を入れます。

| 名前                          | 入れる値                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `SKYWAY_APP_ID`               | SkyWayのアプリケーションID                                                    |
| `SKYWAY_SECRET`               | SkyWayのシークレットキー                                                      |
| `ACCESS_CONTROL_ALLOW_ORIGIN` | AxeのOrigin（例：`https://axe.example.com`）。2つ以上あるときはカンマで区切る |

- 値は、コピーして貼り付けます。前後に空白や改行が入らないように気をつけてください。
- Originの末尾には`/`を付けません。パス（`/udonarium/`など）も付けません。
- 空のままの欄には「Missing」と出ます。3つとも入れると、先に進めます。
- 欄の下の説明の**Learn More**を押すと、このページが開きます。

ほかの設定（トークンの有効期間、ロビーの数）は、あとから足せます。
ここでは入れなくて構いません（→ [設定項目](/skyway/configuration)）。

## 5. デプロイする

**Deploy**を押します。
ボタンが「Deploying」に変わり、その下で「Deployment queued…」「Deployment started…」と進みます。
ビルドは、1〜2分ほどで終わります。

「Deployment completed.」と出たあと、デプロイできたことを知らせる画面に変わります。
そこから、ダッシュボードへ進むボタンを押して、プロジェクトの画面に進みます。

ビルドが失敗したときは、画面に出るログの最後の数行を見てください。
環境変数の誤りは、ビルドでは見つかりません。
デプロイしたあとで、手順7の確かめかたで`CONFIG_INVALID`として出ます。

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
`config.json`のほかの項目は、[Axeの設定](/guide/client-config)にあります。

## 設定を直す

環境変数は、あとから足したり直したりできます。

1. [Vercelのダッシュボード](https://vercel.com/dashboard)で、プロジェクトを開きます。
2. 左のサイドバーの**Environment Variables**を開きます。
3. 直すときは、その変数の行の右の **…** から**Edit**を選び、新しい値を入れて**Save**を押します。
4. 足すときは、変数を足すボタンを押します。「Add Environment Variable」の画面が出るので、**Key**に名前、**Value**に値を入れます。
5. **Type**で、値の種類を選びます。**Secret**は、保存したあと値を画面に出さない種類です。**Config**は、あとから値を見られる種類です。`SKYWAY_SECRET`のような秘密の値は**Secret**にします。
6. **Environments**は最初のままにして、**Save**を押します。

**Secret**にした値は、あとから見られません。
直すときは、新しい値をもう一度入れます。

環境変数を変えても、いま動いているデプロイには反映されません。
変えたあとは、デプロイし直します。

1. 左のサイドバーの**Deployments**を開きます。
2. いちばん上（最新）のデプロイの右の **…** から、**Redeploy**を選びます。古いデプロイからはやり直せないので、いちばん上のものを選びます。
3. 「Redeploy」の画面が出ます。**Choose Environment**は**Production**のままにし、**Use existing Build Cache.** のチェックは外したままにします。
4. **Redeploy**を押します。1〜2分で、新しいデプロイに替わります。

## 独自ドメインで公開する

`*.vercel.app`のURLのままでも使えます。
自分のドメイン（例：`backend.example.com`）で公開したいときは、次のように足します。

1. プロジェクトの**Settings**の**Domains**を開き、**Add Domain**を押します。
2. 使うドメイン（例：`backend.example.com`）を入れて、足します。
3. 画面に、DNSに足すレコードが出ます。`backend.example.com`のようなサブドメインならCNAMEのレコード、`example.com`そのものならAのレコードです。
4. ドメインの管理元（お名前.comなど）のDNSの設定で、画面に出たとおりのレコードを足します。値はプロジェクトごとに違うので、画面に出たものを使います。
5. Vercelの画面で、ドメインの横の表示が設定済みに変われば、使えます。DNSが行きわたるまで、数分から数時間かかることがあります。

足し終えたら、Axeの`backend.url`も新しいURLに書き換えます。

## 更新するとき

Deployボタンで作ったリポジトリは、このリポジトリとは別のものです。
このリポジトリが新しくなっても、あなたのサーバーは自動では変わりません。
新しい版を取り込むには、次のどちらかをします。

- このリポジトリの`apps/vercel`の変更を、自分のリポジトリに取り込む。自分のリポジトリに変更が入ると、Vercelが自動でデプロイし直します。
- もう一度Deployボタンで新しいプロジェクトを作り、環境変数を入れ直して、Axeの`backend.url`を新しいURLに差し替える。

## うまくいかないとき

[SkyWay版で困ったとき](/skyway/troubleshooting)を見てください。
