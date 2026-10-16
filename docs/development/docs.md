# ドキュメントを書く

このドキュメントは[VitePress](https://vitepress.dev/)で作っています。
ソースはリポジトリの`docs/`にあり、`main`に入るとGitHub Pagesに公開されます。

## 手元で見る

```sh
npm install            # リポジトリのルートで
npm run docs:dev       # http://localhost:5173/udonarium_axe_backend/
```

ファイルを保存すると、ブラウザの表示がすぐに変わります。

公開するものと同じ形で確かめるときは、ビルドしてから見ます。

```sh
npm run docs:build     # docs/.vitepress/dist に書き出す
npm run docs:preview
```

ビルドは、存在しないページへのリンクがあると失敗します。

## ファイルの置き場所

| 場所                | 中身                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `docs/index.md`     | トップページ                                                                            |
| `docs/guide/`       | はじめに、選びかた、設置の準備、SkyWayとDiscordのアプリの作りかた、クイックスタートなど |
| `docs/token/`       | SkyWayのトークン発行のしくみとAPI                                                       |
| `docs/php/`         | PHP版                                                                                   |
| `docs/vercel/`      | Vercel版                                                                                |
| `docs/cloudflare/`  | Cloudflare版                                                                            |
| `docs/development/` | 開発に参加する人向け                                                                    |
| `docs/.vitepress/`  | 設定（`config.mts`）とテーマ                                                            |

ページを足したら、`docs/.vitepress/config.mts`の`sidebar`にも足してください。

## 書きかた

まとまった日本語（READMEと`docs/`の本文）は、`yomiyasu`スキルを通して書きます。
フロントエンドと同じ決まりで、プラグインは`.claude/settings.json`の`enabledPlugins`で有効にしてあります。
ほかの日本語校正スキルとは、指示がぶつかるので同時に使いません。
1〜2行の追記や表のセルの手直しは、そのまま書いてかまいません。

- 日本語で、です・ます調で書きます。
- 1文ごとに改行します。段落の中の改行は、表示では詰まります（日本語どうしの間に空白は入りません）。
- 和文と英数字の間に、半角の空白を入れません（例：`Vercel版`、`R2のバケット`、`` `wrangler.jsonc`の ``）。
- 見出しを変えると、その見出しへのリンク（`#…`）が変わります。見出しを変えたら、そのページへのリンクを探して直し、ビルドで確かめます。
- 画面に出るボタンの名前は、実際の表示と同じにします。
- 秘密の値（シークレットキーなど）は、例でも本物を書きません。
- Markdownには、Prettierをかけません。関係のない表の幅まで変わるので、表は手でそろえます。

## 公開

`main`に`docs/`の変更が入ると、`.github/workflows/docs.yml`がビルドしてGitHub Pagesに公開します。
Pull Requestでは、ビルドが通るかだけを確かめます。
