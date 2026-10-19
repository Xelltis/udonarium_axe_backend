import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Upgrades } from '../../src/server/backend.js';
import { asSent, createServer, headersOf } from '../../src/server/node.js';

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
    const seen: string[] = [];
    const port = await listen((request) => {
      seen.push(request.url);
      return new Response('hello');
    });

    const res = await fetch(`http://127.0.0.1:${port}/`);

    expect(await res.text()).toBe('hello');
    expect(seen).toEqual([`http://127.0.0.1:${port}/`]);
  });

  it('names the sender by the socket it came on when nothing in front named one, and keeps one named', async () => {
    const seen: (string | null)[] = [];
    const port = await listen((request) => {
      seen.push(request.headers.get('x-real-ip'));
      return new Response('hello');
    });

    await fetch(`http://127.0.0.1:${port}/`);
    await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-real-ip': '198.51.100.1' } });

    expect(seen).toEqual(['127.0.0.1', '198.51.100.1']);
  });

  it('hands the app the https URL the browser used when a proxy in front ended HTTPS', async () => {
    const seen: string[] = [];
    const port = await listen(async (request) => {
      seen.push(request.url);
      return new Response(await request.text());
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/auth/token?x=1`, {
      method: 'POST',
      headers: { 'x-forwarded-proto': 'https' },
      body: 'sent',
    });

    expect(await res.text()).toBe('sent');
    expect(seen).toEqual([`https://127.0.0.1:${port}/v1/auth/token?x=1`]);
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

  it('gives a socket the https URL too when a proxy in front ended HTTPS', async () => {
    const seen: string[] = [];
    const port = await listen((request) => {
      seen.push(request.url);
      return new Response(null, { status: 403 });
    });

    await tryUpgrade(port, { 'x-forwarded-proto': 'https' });

    expect(seen).toEqual([`https://127.0.0.1:${port}/v1/rooms/r/ws`]);
  });

  it('answers 400 to a socket whose Host makes no URL, and keeps serving', async () => {
    const fetchApp = vi.fn(() => new Response('hello'));
    const port = await listen(fetchApp);

    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(
          'GET /v1/rooms/r/ws HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
        )
      );
      let text = '';
      socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
      socket.on('end', () => resolve(text));
    });

    expect(reply).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(fetchApp).not.toHaveBeenCalled();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('hello');
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

describe('asSent', () => {
  it('keeps the sender a proxy in front named when it puts the URL right', () => {
    const sent = asSent(
      new Request('http://backend.example/v1/rooms', {
        headers: { 'x-forwarded-proto': 'https', 'x-real-ip': '198.51.100.1' },
      }),
      '10.0.0.1'
    );

    expect(sent.url).toBe('https://backend.example/v1/rooms');
    expect(sent.headers.get('x-real-ip')).toBe('198.51.100.1');
  });

  it('leaves a request as it is when there is nothing to put right', () => {
    const request = new Request('http://backend.example/v1/rooms');

    expect(asSent(request)).toBe(request);
    expect(
      asSent(new Request(request, { headers: { 'x-real-ip': '198.51.100.1' } }), '10.0.0.1').headers.get('x-real-ip')
    ).toBe('198.51.100.1');
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
