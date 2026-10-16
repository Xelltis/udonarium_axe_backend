import { waitUntil } from '@vercel/functions';

import { createApp } from '../src/http/app.js';
import { backendProvider, upgrades } from '../src/server/deps.js';
import { createServer } from '../src/server/node.js';

const provider = backendProvider({ defer: waitUntil });

export const app = createApp({
  server: { backendFor: provider.backendFor, sweep: provider.sweep },
});

// The Vercel Node.js runtime hands requests to the Node HTTP server that is the default export.
// The same server also takes the requests that switch over to a WebSocket (the room's WebSocket).
export default createServer(app.fetch, upgrades);
