import { createApp } from '../src/http/app.js';

export const app = createApp();

// Vercel の Node.js ランタイムは、デフォルトエクスポートが `fetch` を持つ場合に
// Web Standard ハンドラとして扱う。Hono の `app.fetch` はクラスプロパティの
// アロー関数なので、そのまま切り出して渡せる。
// `hono/vercel` の `handle()` は素の関数 `(req: Request) => Response` を返すため、
// Node.js ランタイムでは `(req, res) => {}` 形式の Node ハンドラと誤検出される。
export default { fetch: app.fetch };
