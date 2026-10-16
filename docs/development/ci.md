# テスト・CI・リリース

このページでは、GitHub Actionsで何を確かめているか、リリースがどう作られるかを説明します。

## CIのジョブ

`main`へのpushと、`main`へのPull Requestで、`.github/workflows/ci.yml`が走ります。
変更したアプリに関わらず、毎回すべてのジョブを流します。

| ジョブ              | 内容                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP 8.3 / 8.4 / 8.5 | PHP-CS-Fixer、PHPStan、PHPUnit（カバレッジ付き）。8.5のカバレッジをCodecovへ送る                                                                                  |
| Vercel              | 共有のコードの写しが正本と同じかの確認、lint、型検査、素のNodeで読めるかの確認（`check:esm`）、テスト（Redisのサービスを立てて、カバレッジ100%）、Codecovへの送信 |
| Cloudflare          | workerdが1つだけかの確認、共有のコードの写しがVercel版と同じかの確認、lint、型検査、テスト（カバレッジ100%）、Codecovへの送信                                     |
| Deploy Cloudflare   | `main`へのpushのときだけ。Cloudflare版をデプロイする（→ [mainからの自動デプロイ](/cloudflare/auto-deploy)）                                                       |
| Release             | `main`へのpushのときだけ。PHP・Vercel・Cloudflareのジョブが通ったら、リリースを作る                                                                               |

`main`のルールセットでは、Pull Requestを通すことと、必須のチェックが通ることを求めています。

## カバレッジ

- PHP版：`src/`のカバレッジをCodecovへ送ります。
- Vercel版とCloudflare版：行・分岐・関数・文のすべてで100%を求め、下回ると`npm test`が失敗します。
- Codecovでは、アプリごとにフラグ（`php`、`vercel`、`cloudflare`）を分けています。1つのアプリだけを変えたPull Requestでも、ほかのアプリの値を引き継ぎます。
- Pull Requestで変えた行（パッチ）には、100%のカバレッジを求めます。

## リリース

`main`にpushされ、CIが通ると、[semantic-release](https://semantic-release.gitbook.io/)がリリースを作ります。

1. 前のリリースからのコミットメッセージを読み、次の版を決めます（`fix`ならパッチ、`feat`ならマイナー、`BREAKING CHANGE`ならメジャー）。
2. PHP版の配布用zip（`udonarium-axe-backend-<版>.zip`）を作ります。zipの直下に`apps/php`の中身が来るので、展開すればそのままドキュメントルートになります。
3. GitHubのリリースを作り、zipを添付します。
4. `CHANGELOG.md`を更新するコミットを`main`に積みます。

版はリポジトリ全体で1つです。
Vercel版とCloudflare版は、それぞれの方法でデプロイするので、zipには入りません。

## 依存関係の更新

Dependabotが、毎週次のものの更新を提案します。

| 対象                | 場所              |
| ------------------- | ----------------- |
| composer            | `apps/php`        |
| npm（ルートの道具） | `/`               |
| npm                 | `apps/vercel`     |
| npm                 | `apps/cloudflare` |
| GitHub Actions      | `/`               |
| Docker              | `apps/php`        |

Cloudflare版の`wrangler`は、`@cloudflare/vitest-pool-workers`が使う版に合わせて手で上げるので、Dependabotの対象から外しています。
