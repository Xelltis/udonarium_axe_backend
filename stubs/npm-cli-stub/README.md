# npm-cli-stub

`@semantic-release/npm` の依存する `npm` パッケージ（npm CLI 本体）を差し替えるための空のスタブ。
ルートの `package.json` の `overrides` から `file:` 参照される。

## 背景

`@semantic-release/npm` は npm CLI を **bundled dependencies 込みで丸ごと同梱**する。
この同梱物（`tar` / `undici` / `brace-expansion` / `ip-address`）に上流未修正の脆弱性があり、
bundled dependencies は tarball に埋め込まれているため `overrides` では個別に書き換えられない。

一方このリポジトリは npm レジストリへ公開しない（`"private": true`）ため、
`@semantic-release/npm` は `.releaserc.json` の `plugins` に含めておらず、一度も実行されない。
`semantic-release` 本体でも、このプラグイン名が現れるのは `lib/get-config.js` の
**デフォルト** `plugins` 配列内の文字列としてのみで、`.releaserc.json` が `plugins` を
明示指定している以上そのデフォルトは丸ごと上書きされ、動的 import されることはない。

## なぜ安全か

`@semantic-release/npm` は `npm` を JavaScript モジュールとして import しない。
`lib/verify-auth.js` や `lib/prepare.js` が

```js
execa("npm", ["whoami", ...], { preferLocal: true })
```

のように **CLI をシェル実行**するだけで、`npm` への依存は
`node_modules/.bin/npm` を用意する目的しか持たない。

このスタブは意図的に `bin` を持たない。そのため万が一将来
`@semantic-release/npm` をプラグインとして有効化した場合でも、`preferLocal` は
`node_modules/.bin` に npm を見つけられず、PATH 上の本物の npm に
フォールバックして正常に動作する。

no-op な `bin` を置くと「publish が成功したように見えて実際には何もしない」という
危険な失敗モードを生むため、あえて空にしている。

## 注意

`overrides` の追加・変更は既存の `package-lock.json` には反映されない
（`npm ls` が `invalid` を報告する状態になる）。
このスタブを触るときは `package-lock.json` を削除してから `npm install` し直すこと。
`npm ci` は生成済みの lock をそのまま使うので影響を受けない。

## 解除するとき

上流の `npm` が bundled dependencies を更新したら、ルート `package.json` の
`overrides` とこのディレクトリを削除して `npm install` し直すこと。
`npm audit` が 0 件のままなら不要になった証拠。
