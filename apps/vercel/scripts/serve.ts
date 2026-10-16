// Runs the room server locally. vercel dev sometimes does not let WebSockets through, so this starts
// the same Node server as on Vercel, as it is. The settings come from .env.local (if there is one)
// and the environment variables, and are read on each request.
// Listens on PORT (3000 by default).
import { existsSync } from 'node:fs';

import server from '../api/index.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Listening on http://localhost:${port}`));
