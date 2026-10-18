## 概要

<!-- このPRで何を変更しましたか？ -->

## 変更内容

<!-- 変更の詳細を箇条書きで記載してください -->

-

## テスト

<!-- どのようにテストしましたか？触ったアプリの項目だけ残してください -->

- [ ] `apps/php`で`bin/phpunit`・`bin/phpstan analyse`・`bin/php-cs-fixer check`が通ること
- [ ] `apps/vercel`で`npm run lint`・`npm run format:check`・`npm run typecheck`・`npm run check:esm`・`npm test`が通ること
- [ ] `apps/cloudflare`で`npm run lint`・`npm run format:check`・`npm run typecheck`・`npm test`が通ること
- [ ] 共有のコードを変えたときは、`node scripts/sync-shared.mjs --check`が通ること
