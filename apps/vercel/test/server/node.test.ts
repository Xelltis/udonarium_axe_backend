import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Upgrades } from '../../src/server/backend.js';
import { createServer, headersOf } from '../../src/server/node.js';

const servers: { close: () => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.restoreAllMocks();
});

/** Starts a server and returns its port number. */
const listen = async (
  fetch: (request: Request) => Response | Promise<Response>,
  upgrades: Upgrades = new WeakMap()
) => {
  const server = createServer(fetch, upgrades);
  servers.push({ close: () => server.close() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

/** Connects a WebSocket, and returns whether it connected or was answered over HTTP. */
const tryUpgrade = (port: number, headers: Record<string, string> = {}) =>
  new Promise<
    | { open: true; ws: WebSocket; first: Promise<string> }
    | { open: false; status?: number; body?: string; error?: string }
  >((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/rooms/r/ws`, { headers });
    // Listens first, so that what comes right after connecting is not lost.
    const first = new Promise<string>((resolveFirst) => ws.once('message', (data) => resolveFirst(String(data))));
    ws.once('open', () => resolve({ open: true, ws, first }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ open: false, status: res.statusCode, body }));
    });
    ws.once('error', (err) => resolve({ open: false, error: err.message }));
  });

describe('the Node server', () => {
  it('serves plain requests through the app', async () => {
    const port = await listen(() => new Response('hello'));

    const res = await fetch(`http://127.0.0.1:${port}/`);

    expect(await res.text()).toBe('hello');
  });

  it('answers in HTTP a socket the app does not take, and closes', async () => {
    const seen: Request[] = [];
    const port = await listen((request) => {
      seen.push(request);
      return Response.json({ error: 'origin-not-allowed' }, { status: 403 });
    });

    const answer = await tryUpgrade(port, { 'x-real-ip': '192.0.2.1' });

    expect(answer).toEqual({ open: false, status: 403, body: '{"error":"origin-not-allowed"}' });
    expect(seen[0].headers.get('x-real-ip')).toBe('192.0.2.1');
    expect(seen[0].url).toBe(`http://127.0.0.1:${port}/v1/rooms/r/ws`);
  });

  it('answers a status it has no words for', async () => {
    const port = await listen(() => new Response(null, { status: 599 }));
    expect(await tryUpgrade(port)).toMatchObject({ open: false, status: 599 });
  });

  it('gives a socket to the room the app hands it to', async () => {
    const upgrades: Upgrades = new WeakMap();
    const port = await listen((request) => {
      upgrades.get(request)?.((ws) => ws.send('welcome'));
      return new Response(null);
    }, upgrades);

    const answer = await tryUpgrade(port);
    expect(answer.open).toBe(true);
    if (answer.open) {
      expect(await answer.first).toBe('welcome');
      answer.ws.close();
    }
  });

  it('drops a socket whose request the app could not answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const port = await listen(() => {
      throw new Error('broken');
    });

    expect(await tryUpgrade(port)).toMatchObject({ open: false, error: expect.any(String) });
    expect(error).toHaveBeenCalledWith('Upgrade failed:', expect.any(Error));
  });
});

describe('headersOf', () => {
  const incoming = (headers: Record<string, string | string[] | undefined>, remoteAddress?: string) =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('copies every header, repeated ones too, and adds where the request came from', () => {
    const headers = headersOf(
      incoming({ 'set-cookie': ['a=1', 'b=2'], skipped: undefined, origin: 'https://app.example' }, '192.0.2.9')
    );

    expect(headers.get('set-cookie')).toBe('a=1, b=2');
    expect(headers.has('skipped')).toBe(false);
    expect(headers.get('origin')).toBe('https://app.example');
    expect(headers.get('x-real-ip')).toBe('192.0.2.9');
  });

  it('keeps the sender a proxy named, and names none it does not know', () => {
    expect(headersOf(incoming({ 'x-real-ip': '198.51.100.1' }, '10.0.0.1')).get('x-real-ip')).toBe('198.51.100.1');
    expect(headersOf(incoming({})).has('x-real-ip')).toBe(false);
  });
});
