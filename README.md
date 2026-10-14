# udonarium-axe-backend

[![CI](https://github.com/Xelltis/udonarium_axe_backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Xelltis/udonarium_axe_backend/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Xelltis/udonarium_axe_backend)](https://github.com/Xelltis/udonarium_axe_backend/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Udonarium Axe](https://github.com/Xelltis/udonarium_axe)のバックエンドを集めたリポジトリです。
動かす場所ごとに、`apps/`の下へ分けて置いています。

| ディレクトリ                       | 内容                                      | 動かす場所                            |
| ---------------------------------- | ----------------------------------------- | ------------------------------------- |
| [apps/php](apps/php)               | SkyWayの認証トークンを発行するPHP実装     | レンタルサーバー（Apache＋PHP 8.3〜） |
| [apps/vercel](apps/vercel)         | 同じトークン発行をHonoで書いたもの        | Vercel Functions（Node.js 24）        |
| [apps/cloudflare](apps/cloudflare) | 画像と音声をSHA-256の名前でR2に置くWorker | Cloudflare Workers＋R2                |

## セルフホスト

PHP版は[リリース](https://github.com/Xelltis/udonarium_axe_backend/releases/latest)のzipを使います。
展開した中身をそのままドキュメントルートに置き、`.env`を作ります。
詳しい手順は[apps/php/README.md](apps/php/README.md)です。

Vercel版とCloudflare版は、ボタンから自分のアカウントにデプロイできます。
このリポジトリのそのディレクトリが、自分のGitHubリポジトリとして複製されます。
同じアカウントに何度でもデプロイでき、名前を変えればそれぞれ別のものになります。

Vercel版（SkyWayの認証トークンの発行）:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FXelltis%2Fudonarium_axe_backend%2Ftree%2Fmain%2Fapps%2Fvercel&env=SKYWAY_APP_ID,SKYWAY_SECRET,ACCESS_CONTROL_ALLOW_ORIGIN&project-name=my-udonarium-backend-vercel&repository-name=my-udonarium-backend-vercel)

要る環境変数は[apps/vercel/README.md](apps/vercel/README.md)にあります。

Cloudflare版（画像と音声の置き場）:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Xelltis/udonarium_axe_backend/tree/main/apps/cloudflare)

R2のバケットはデプロイのときに作られます。
前もって、アカウントでR2を使い始めておくことが要ります。
詳しくは[apps/cloudflare/README.md](apps/cloudflare/README.md)にあります。

## 開発

開発環境の作り方とコミットの決まりは[CONTRIBUTING.md](CONTRIBUTING.md)にあります。
版はリポジトリ全体で1つで、mainのコミットからsemantic-releaseが付けます。

## ライセンス

[MIT](LICENSE)
