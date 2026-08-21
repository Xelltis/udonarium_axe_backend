# udonarium-axe-backend

[![CI](https://github.com/Xelltis/udonarium_axe_backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Xelltis/udonarium_axe_backend/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Xelltis/udonarium_axe_backend/graph/badge.svg)](https://codecov.io/gh/Xelltis/udonarium_axe_backend)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[ユドナリウム](https://github.com/TK11235/udonarium) 向け SkyWay 2023 JWT 認証バックエンドです。
レンタルサーバー（Apache + PHP 8.3）で動作する軽量な PHP 実装です。

## 機能

- **ウェルカムエンドポイント** (`GET /`)
- **ヘルスチェック** (`GET /v1/status`)
- **SkyWay 2023 JWT トークン発行** (`POST /v1/skyway2023/token`)
- **CORS 検証**（許可オリジンのみ受け付け）
- **Apache `.htaccess`** による機密ファイルの遮断
- サブディレクトリ運用対応

## 必要環境

| 環境   | バージョン       |
| ------ | ---------------- |
| PHP    | 8.3 以上         |
| Apache | mod_rewrite 有効 |

## クイックスタート

```sh
# 1. ドキュメントルートに配置
# 2. .env を作成して SkyWay の認証情報を設定
cp .env.example .env

# 3. 動作確認
curl https://your-backend.example.com/v1/status
# => OK
```

詳細なセットアップ手順は [docs/setup.md](docs/setup.md) を参照してください。

## ドキュメント

| ドキュメント                                  | 内容                                           |
| --------------------------------------------- | ---------------------------------------------- |
| [セットアップガイド](docs/setup.md)           | 配置・`.env` 設定・パーミッション・Apache 設定 |
| [API リファレンス](docs/api.md)               | エンドポイント仕様・リクエスト/レスポンス例    |
| [コントリビューションガイド](CONTRIBUTING.md) | 開発環境・テスト・コーディング規約             |
| [セキュリティポリシー](SECURITY.md)           | 脆弱性の報告方法                               |

## ライセンス

[MIT](LICENSE)
