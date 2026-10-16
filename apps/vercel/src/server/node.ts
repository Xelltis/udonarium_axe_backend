import { createAdaptorServer } from '@hono/node-server';
import type { IncomingMessage, Server } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

import type { Upgrades } from './backend.js';

/** WebSocket の1つのメッセージの上限。Cloudflare の Durable Object が受ける大きさと同じ */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

type Fetch = (request: Request) => Response | Promise<Response>;

/** つないできたソケットの番地を、x-real-ip が無ければ足す（手元のサーバー。Vercel は自分で付ける） */
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

/** WebSocket に替えなかった要求に、HTTP のまま答えて閉じる */
const answer = async (socket: Duplex, response: Response): Promise<void> => {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}`];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  lines.push(`content-length: ${body.byteLength}`, 'connection: close', '', '');
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]));
};

/**
 * Hono の app を、WebSocket も受ける Node の HTTP サーバーにする。WebSocket につなぎ替える要求も
 * app に通し、部屋の経路が Origin・部屋の鍵・数を確かめてから、upgrades を通して ws に渡す
 */
export const createServer = (fetch: Fetch, upgrades: Upgrades): Server => {
  const server = createAdaptorServer({ fetch }) as Server;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });

  server.on('upgrade', (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node の HTTP サーバーは、Host の無い要求を受けない
    const request = new Request(
      `http://${incoming.headers.host as string}${incoming.url as string}`,
      {
        headers: headersOf(incoming),
      },
    );
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
