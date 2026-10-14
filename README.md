# udonarium-axe-backend

[![CI](https://github.com/Xelltis/udonarium_axe_backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Xelltis/udonarium_axe_backend/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Xelltis/udonarium_axe_backend)](https://github.com/Xelltis/udonarium_axe_backend/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Udonarium Axe](https://github.com/Xelltis/udonarium_axe)のバックエンドを集めたリポジトリです。
動かす場所ごとに、`apps/`の下へ分けて置いています。

| ディレクトリ         | 内容                                  | 動かす場所                            |
| -------------------- | ------------------------------------- | ------------------------------------- |
| [apps/php](apps/php) | SkyWayの認証トークンを発行するPHP実装 | レンタルサーバー（Apache＋PHP 8.3〜） |

## セルフホスト

PHP版は[リリース](https://github.com/Xelltis/udonarium_axe_backend/releases/latest)のzipを使います。
展開した中身をそのままドキュメントルートに置き、`.env`を作ります。
詳しい手順は[apps/php/README.md](apps/php/README.md)です。

## 開発

開発環境の作り方とコミットの決まりは[CONTRIBUTING.md](CONTRIBUTING.md)にあります。
版はリポジトリ全体で1つで、mainへのマージのたびにsemantic-releaseが付けます。

## ライセンス

[MIT](LICENSE)
