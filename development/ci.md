# テスト・CI・リリース

このページでは、GitHub Actionsで何を確かめているか、リリースがどう作られるかを説明します。

## CIのジョブ

`main`へのpushと、`main`へのPull Requestで、`.github/workflows/ci.yml`が走ります。
変更したアプリに関わらず、毎回すべてのジョブを流します。

| ジョブ              | 内容                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP 8.3 / 8.4 / 8.5 | PHP-CS-Fixer、PHPStan、PHPUnit（カバレッジ付き）。8.5のカバレッジをCodecovへ送る                                                                                              |
| Vercel              | 共有のコードの写しが正本と同じかの確認、lint、整形の確認、型検査、素のNodeで読めるかの確認（`check:esm`）、テスト（Redisのサービスを立てて、カバレッジ100%）、Codecovへの送信 |
| Cloudflare          | workerdが1つだけかの確認、共有のコードの写しがVercel版と同じかの確認、lint、整形の確認、型検査、テスト（カバレッジ100%）、Codecovへの送信                                     |
| Deploy Cloudflare   | `main`へのpushのときだけ。Cloudflare版をデプロイする（→ [自分のリポジトリから自動でデプロイする](https://xelltis.github.io/udonarium_axe_backend/operate/auto-deploy)）                                                                   |
| Release             | `main`へのpushのときだけ。PHP・Vercel・Cloudflareのジョブが通ったら、リリースを作る                                                                                           |

`main`のルールセットでは、Pull Requestを通すことと、必須のチェックが通ることを求めています。

## カバレッジ

- PHP版：`src/`のカバレッジをCodecovへ送ります。
- Vercel版とCloudflare版：行・分岐・関数・文のすべてで100%を求め、下回ると`npm test`が失敗します。
- Codecovでは、アプリごとにフラグ（`php`、`vercel`、`cloudflare`）を分けています。1つのアプリだけを変えたPull Requestでも、ほかのアプリの値を引き継ぎます。
- Pull Requestで変えた行（パッチ）には、100%のカバレッジを求めます。

## リリース

`main`にpushされ、CIが通ると、CIの`release`のジョブがリリースを作ります。

1. PHP版の配布用zipを作ります。zipの直下に`apps/php`の中身が来るので、展開すればそのままドキュメントルートになります。
2. [semantic-release](https://semantic-release.gitbook.io/)が、前のリリースからのコミットメッセージを読み、次の版を決めます（`fix`ならパッチ、`feat`ならマイナー、`BREAKING CHANGE`ならメジャー）。
3. `CHANGELOG.md`を書き足し、GitHubのリリースを作って、zipを`udonarium-axe-backend-<版>.zip`として添付します。
4. `CHANGELOG.md`を更新するコミットを`main`に積みます。

zipは、semantic-releaseが`CHANGELOG.md`を書き足す前に作ります。
そのため、zipの中の`CHANGELOG.md`には、その版の変更はまだ載っていません。
その版の変更は、GitHubのリリースノートで見ます。

版はリポジトリ全体で1つです。
Vercel版とCloudflare版は、それぞれの方法でデプロイするので、zipには入りません。

## 依存関係の更新

Dependabotが、毎週次のものの更新を提案します。

| 対象                | 場所                             |
| ------------------- | -------------------------------- |
| composer            | `apps/php`                       |
| npm（ルートの道具） | `/`                              |
| npm                 | `apps/vercel`・`apps/cloudflare` |
| GitHub Actions      | `/`                              |
| Docker              | `apps/php`                       |

Vercel版とCloudflare版は1つの設定にまとめています。
共有のコードが使うパッケージ（hono・valibot・@msgpack/msgpack・bcdice）とPrettierは、両方のアプリの分を1つのPull Requestで上げます。
片方だけ上がると、CIの写しの確認で落ちるためです。
ほかのパッケージは、アプリごとに別のPull Requestになります。

Cloudflare版の`wrangler`は、`@cloudflare/vitest-pool-workers`が使う版に合わせて手で上げるので、Dependabotの対象から外しています。
