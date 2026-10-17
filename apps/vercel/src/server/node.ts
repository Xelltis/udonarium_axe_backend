import { createAdaptorServer } from '@hono/node-server';
import type { IncomingMessage, Server } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

import type { Upgrades } from './backend.js';

/** The limit on one WebSocket message. The same size as a Cloudflare Durable Object takes. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

type Fetch = (request: Request) => Response | Promise<Response>;

/** Adds the connecting socket's address when there is no x-real-ip (the local server; Vercel adds it itself). */
export const headersOf = (incoming: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  if (!headers.has('x-real-ip') && incoming.socket.remoteAddress) {
    headers.set('x-real-ip', incoming.socket.remoteAddress);
  }
  return headers;
};

/** Answers a request that did not switch to a WebSocket over plain HTTP, and closes it. */
const answer = async (socket: Duplex, response: Response): Promise<void> => {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}`];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  lines.push(`content-length: ${body.byteLength}`, 'connection: close', '', '');
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]));
};

/**
 * Makes the Hono app a Node HTTP server that takes WebSockets too. Requests that switch over to a
 * WebSocket also go through the app, and once the room route has checked the Origin, the room key
 * and the count, they are handed to ws through upgrades.
 */
export const createServer = (fetch: Fetch, upgrades: Upgrades): Server => {
  const server = createAdaptorServer({ fetch }) as Server;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });

  server.on('upgrade', (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    let request: Request;
    try {
      // The Node HTTP server does not take a request without a Host.
      request = new Request(`http://${incoming.headers.host as string}${incoming.url as string}`, {
        headers: headersOf(incoming),
      });
    } catch {
      // A Host that makes no URL. Thrown out of this listener, it would take the whole process down.
      void answer(socket, new Response(null, { status: 400 }));
      return;
    }
    let upgraded = false;
    upgrades.set(request, (onSocket) => {
      upgraded = true;
      wss.handleUpgrade(incoming, socket, head, onSocket);
    });
    Promise.resolve()
      .then(() => fetch(request))
      .then((response) => (upgraded ? undefined : answer(socket, response)))
      .catch((err: unknown) => {
        console.error('Upgrade failed:', err);
        socket.destroy();
      });
  });
  return server;
};
