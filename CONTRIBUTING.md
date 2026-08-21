# コントリビューションガイド

udonarium-axe-backend へのコントリビューションを歓迎します！

## 開発環境のセットアップ

Docker で開発環境を構築できます。

```sh
# リポジトリをクローン
git clone https://github.com/Xelltis/udonarium_axe_backend.git
cd udonarium_axe_backend

# Docker で起動
docker compose up -d

# npm 依存のインストール（commitlint 用）
npm install

# Git hooks をインストール（lefthook が必要）
npx lefthook install
```

`http://localhost:3000` でアクセスできます。

## 開発フロー

1. `main` ブランチから作業ブランチを作成する
2. 変更を加える
3. テスト・静的解析・フォーマットチェックを通す
4. Pull Request を作成する

## コマンド一覧

```sh
# テスト
bin/phpunit

# 静的解析（PHPStan level 9）
bin/phpstan analyse

# コードフォーマット
bin/php-cs-fixer fix

# フォーマットチェック（CI と同等）
bin/php-cs-fixer check
```

## コーディング規約

- **PHP 8.3 との互換性を維持する** — `src/` および `index.php` では PHP 8.4 以降でのみ利用可能な機能（プロパティフック等）は使用しないでください
- **テストは PHPUnit 12 / 13 の両方で動作させる** — CI は PHP 8.3（PHPUnit 12）と PHP 8.4+（PHPUnit 13）の両方でテストを実行します
- **PHP-CS-Fixer** (`@PER-CS`) に従う
- すべての PHP ファイルに `declare(strict_types=1)` を記述する
- PHPStan level 9 でエラーが出ないこと

## コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/ja/) に従ってください。
lefthook の `commit-msg` フックで自動検証されます。

```
feat: 新機能の説明
fix: バグ修正の説明
docs: ドキュメントの変更
chore: その他の変更
```

## Pull Request

- CI（PHPStan・PHPUnit・PHP-CS-Fixer）が全て通ることを確認してください
- 可能な限りテストを追加してください
- 1 つの PR につき 1 つの変更に絞ってください

## バグ報告・機能提案

[Issues](https://github.com/Xelltis/udonarium_axe_backend/issues) から報告してください。

## セキュリティ

脆弱性を発見した場合は Issue ではなく [SECURITY.md](SECURITY.md) の手順に従ってください。
