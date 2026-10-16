// 手元で部屋のサーバーを動かす。vercel dev は WebSocket を通さないことがあるので、Vercel の上と同じ
// Node のサーバーをそのまま立てる。設定は .env.local（あれば）と環境変数から、要求のたびに読む。
// PORT（既定 3000）で待つ
import { existsSync } from 'node:fs';

import server from '../api/index.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening on http://localhost:${port}`));
