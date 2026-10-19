import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../contracts/protocol.js';
import { BanList } from '../../src/core/moderation/bans.js';
import type { Ban } from '../../src/core/moderation/bans.js';
import { MAX_WAITING_FRAMES } from '../../src/core/rooms/limits.js';
import { hashPassword } from '../../src/core/rooms/password.js';
import { FakeHost } from './fake-host.js';
import type { FakeConn } from './fake-host.js';

// A room checks each hello against the operator's bans as they stand. With the room in memory, the
// bans are given at once, or later as a room server's store gives them.

const banOf = (kind: Ban['kind'], value: string): Ban => ({ kind, value, reason: '', createdAt: 0, expiresAt: null });

/** Lets work that waits on promises already settled run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A room whose bans come only when the test hands them over, one read at a time. */
const waitingHost = () => {
  const host = new FakeHost();
  const reads: ((bans: BanList) => void)[] = [];
  host.bansOf = () => new Promise<BanList>((resolve) => reads.push(resolve));
  return { host, reads };
};

/** Sends a guest's hello (without a token). */
const guestHello = (host: FakeHost, conn: FakeConn, peerId: string, extra: Record<string, unknown> = {}) =>
  host.engine.receive(
    conn,
    encode({ type: 'hello', protocolVersion: PROTOCOL_VERSION, peerId, userId: `guest-${peerId}`, ...extra })
  );

const errorsOf = (conn: FakeConn) => conn.of('error').map((error) => error.code);

describe('a hello against the bans at hand', () => {
  it('turns a banned sender away before the room is looked at, such as its password', () => {
    const host = new FakeHost();
    host.facts = { roomKey: 'room', password: hashPassword('secret') };
    host.bansOf = () => new BanList([banOf('ip', '192.0.2.0/24')]);

    const sender = host.connect('192.0.2.5');
    guestHello(host, sender, 'stranger', { password: 'wrong' });
    const other = host.connect('198.51.100.2');
    guestHello(host, other, 'other', { password: 'secret' });

    expect(errorsOf(sender)).toEqual(['unauthorized']);
    expect(sender.closed?.reason).toBe('unauthorized');
    expect(other.of('welcome')).toHaveLength(1);
  });

  it('turns a banned account away once its token is read', () => {
    const host = new FakeHost();
    host.bansOf = () => new BanList([banOf('discord', 'mal')]);

    const mal = host.join('mal');
    const alice = host.join('alice');

    expect(errorsOf(mal)).toEqual(['unauthorized']);
    expect(mal.seat).toBeNull();
    expect(alice.of('welcome')).toHaveLength(1);
  });
});

describe('a hello that waits for the bans', () => {
  it('is let in once they come, and what came behind it is taken in after it, in order', async () => {
    const { host, reads } = waitingHost();
    const conn = host.connect();

    host.hello(conn, 'alice');
    host.engine.receive(conn, encode({ type: 'time' }));
    expect(conn.received).toEqual([]);

    reads[0]?.(new BanList([]));
    await settle();
    reads[1]?.(new BanList([]));
    await settle();

    expect(conn.received.map((message) => message.type)).toEqual(['welcome', 'data', 'time']);
    expect(conn.closed).toBeNull();
  });

  it('is turned away by a ban made while it waited, and reads them no more', async () => {
    const { host, reads } = waitingHost();
    const conn = host.connect('192.0.2.5');

    guestHello(host, conn, 'stranger');
    host.engine.receive(conn, encode({ type: 'time' }));
    reads[0]?.(new BanList([banOf('ip', '192.0.2.5/32')]));
    await settle();

    expect(errorsOf(conn)).toEqual(['unauthorized']);
    expect(conn.of('time')).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it('closes a connection that sends too much behind it, and lets it in no more', async () => {
    const { host, reads } = waitingHost();
    const conn = host.connect();

    host.hello(conn, 'alice');
    for (let i = 0; i <= MAX_WAITING_FRAMES + 1; i++) host.engine.receive(conn, encode({ type: 'time' }));
    reads[0]?.(new BanList([]));
    await settle();

    expect(errorsOf(conn)).toEqual(['too-many-messages']);
    expect(conn.seat).toBeNull();
  });

  it('lets nothing in for a connection that went while it waited', async () => {
    const { host, reads } = waitingHost();
    const conn = host.connect();

    host.hello(conn, 'alice');
    host.engine.closed(conn);
    reads[0]?.(new BanList([]));
    await settle();

    expect(conn.received).toEqual([]);
    expect(conn.seat).toBeNull();
  });
});

describe('a seat let in on bans that waited', () => {
  it('reads them again once the room list has been told, and closes it when a ban came in between', async () => {
    const { host, reads } = waitingHost();
    let listed!: () => void;
    host.listedOf = () => new Promise<void>((resolve) => (listed = resolve));
    const bob = host.join('bob');
    reads[0]?.(new BanList([]));
    await settle();
    listed();
    await settle();
    reads[1]?.(new BanList([]));
    await settle();
    const mal = host.connect();
    host.hello(mal, 'mal');

    reads[2]?.(new BanList([]));
    await settle();
    expect(mal.of('welcome')).toHaveLength(1);
    expect(reads).toHaveLength(3);
    listed();
    await settle();
    reads[3]?.(new BanList([banOf('discord', 'mal')]));
    await settle();

    expect(errorsOf(mal)).toEqual(['unauthorized']);
    expect(bob.of('leave')).toEqual([{ type: 'leave', peerId: 'mal' }]);
    expect(bob.closed).toBeNull();
  });

  it('is left alone when it has gone or been closed by the time they are read again', async () => {
    const { host, reads } = waitingHost();
    const gone = host.join('gone');
    const closed = host.join('closed');
    reads[0]?.(new BanList([]));
    reads[1]?.(new BanList([]));
    await settle();

    host.engine.closed(gone);
    host.engine.expel((seat) => seat.peerId === 'closed');
    const everyBan = new BanList([banOf('discord', 'gone'), banOf('discord', 'closed')]);
    reads[2]?.(everyBan);
    reads[3]?.(everyBan);
    await settle();

    expect(errorsOf(gone)).toEqual([]);
    expect(errorsOf(closed)).toEqual(['unauthorized']);
  });
});
