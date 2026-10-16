import { waitUntil } from '@vercel/functions';

import { createApp } from '../src/http/app.js';
import { backendProvider, upgrades } from '../src/server/deps.js';
import { createServer } from '../src/server/node.js';

const provider = backendProvider({ defer: waitUntil });

export const app = createApp({
  server: { backendFor: provider.backendFor, sweep: provider.sweep },
});

// Vercel の Node.js ランタイムは、デフォルトエクスポートの Node の HTTP サーバーに要求を渡す。
// WebSocket につなぎ替える要求も同じサーバーが受ける（部屋の WebSocket）
export default createServer(app.fetch, upgrades);
