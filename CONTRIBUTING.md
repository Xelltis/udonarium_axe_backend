# コントリビューションガイド

udonarium-axe-backendへのコントリビューションを歓迎します。

開発の準備、アプリごとのコマンドと決まり、コミットとPull Requestの決まりは、[開発に参加する](development/README.md)にまとめています。
テストとCIとリリースは[テスト・CI・リリース](development/ci.md)を、文書の書きかたは[ドキュメントを書く](development/docs.md)を見てください。
決まりはフロントエンド（[Udonarium Axe](https://github.com/Xelltis/udonarium_axe)）とそろえています。

## 要点

- コミットメッセージは、件名も本文も英語で、[Conventional Commits](https://www.conventionalcommits.org/ja/)の形で書きます。
- 1つのコミットには1つの論理的な変更を、1つのPull Requestには1つの変更を入れます。
- lefthookのフックは`npx lefthook install`で入れ、迂回しません。
- コードのコメントとテスト名は英語で書きます。
- テストを足し、CIがすべて通ることを確かめます。

## バグ報告・機能提案

[Issues](https://github.com/Xelltis/udonarium_axe_backend/issues)から報告してください。

## セキュリティ

脆弱性を見つけたときは、Issueではなく[SECURITY.md](SECURITY.md)の手順に従ってください。
