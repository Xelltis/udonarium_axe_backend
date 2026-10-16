import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_TAB_LIST_IDENTIFIER, CLOSE_CODE, SyncEvent } from '../../contracts/protocol.js';
import { FLUSH_DELAY_MS } from '../../src/core/rooms/limits.js';
import { FakeHost } from './fake-host.js';

// Checks, with the room in memory, what is hard to bring about from the room server.

afterEach(() => {
  vi.useRealTimers();
});

const contextOf = (
  identifier: string,
  majorVersion = 1,
  syncData: Record<string, unknown> = { value: identifier },
  aliasName = 'character'
) => ({ aliasName, identifier, majorVersion, minorVersion: 0.5, syncData });

const update = (data: unknown) => ({ eventName: SyncEvent.UPDATE, data });

describe('a room being deleted', () => {
  it('tells and closes only the connections still open', async () => {
    const host = new FakeHost();
    const open = host.join('open');
    const gone = host.join('gone');
    const refused = host.connect();
    host.engine.closed(gone);
    host.engine.receive(refused, 'not a frame');

    host.engine.closeAll();

    expect(open.of('error').map((error) => error.code)).toEqual(['room-deleted']);
    expect(open.closed).toEqual({ code: CLOSE_CODE, reason: 'room-deleted' });
    expect(gone.closed).toBeNull();
    expect(refused.of('error').map((error) => error.code)).toEqual(['bad-message']);
  });

  it('takes nothing in while the room is being wiped, and lets nobody upload', () => {
    const host = new FakeHost();
    const seated = host.join('seated');
    const waiting = host.connect();
    host.deleting = true;

    host.emit(seated, [update(contextOf('late'))]);
    host.engine.receive(waiting, new Uint8Array([0x80]));

    expect(seated.of('error').at(-1)?.code).toBe('room-deleted');
    expect(waiting.of('error').at(-1)?.code).toBe('room-not-found');
    expect(host.engine.canUpload('user-seated')).toBe('room-not-found');
  });

  it('turns away a hello once the room has gone', () => {
    const host = new FakeHost();
    const conn = host.connect();
    host.facts = null;

    host.hello(conn, 'late');

    expect(conn.of('error').map((error) => error.code)).toEqual(['room-not-found']);
  });

  it('puts no roll in place once the room has gone', async () => {
    const host = new FakeHost();
    const gm = host.join('gm', 'gm');
    host.emit(gm, [
      update(contextOf(CHAT_TAB_LIST_IDENTIFIER, 1, { attributes: {} }, 'chat-tab-list')),
      update(
        contextOf('main', 1, { parentIdentifier: CHAT_TAB_LIST_IDENTIFIER, attributes: { name: 'main' } }, 'chat-tab')
      ),
    ]);
    host.emit(gm, [
      {
        eventName: 'ROLL_REQUEST',
        data: {
          gameSystem: 'DiceBot',
          command: '1d1',
          speaker: 'gm',
          message: contextOf('rolled', 1, { parentIdentifier: 'main', value: '' }, 'chat'),
        },
      },
    ]);
    host.facts = null;

    await Promise.all(host.deferred);

    expect(host.objects.entryOf('rolled')).toBeNull();
    expect(host.events.some(([event]) => event === 'roll')).toBe(false);
  });
});

describe('welcoming', () => {
  it('tells how to put up assets when the room server has its own way, and says nothing when it has not', () => {
    const host = new FakeHost();
    const told = host.join('told');
    host.policy = null;
    const plain = host.join('plain');

    expect(told.of('welcome')[0]?.assetUpload).toEqual({
      maxPutBytes: 4_000_000,
      directUpload: true,
    });
    expect(plain.of('welcome')[0]).not.toHaveProperty('assetUpload');
  });
});

describe('leaving', () => {
  it('counts a connection gone only once', () => {
    const host = new FakeHost();
    const alice = host.join('alice');
    const bob = host.join('bob');

    host.engine.closed(bob);
    host.engine.closed(bob);

    expect(alice.of('leave')).toEqual([{ type: 'leave', peerId: 'bob' }]);
  });

  it('clears away the cursors of those who are not here', () => {
    const host = new FakeHost();
    const alice = host.join('alice');
    host.objects.put(contextOf('cursor-ghost', 1, { peerId: 'ghost' }, 'PeerCursor'), 'ghost');

    host.engine.dropStrayCursors();

    expect(alice.of('data').at(-1)?.events).toEqual([
      {
        eventName: SyncEvent.DELETE,
        data: { aliasName: 'PeerCursor', identifier: 'cursor-ghost' },
        sendFrom: '@authority',
      },
    ]);
    expect(host.objects.entryOf('cursor-ghost')).toBeNull();
  });
});

describe('writing', () => {
  it('writes what waits after a short while, and at once when asked', () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const alice = host.join('alice');
    host.emit(alice, [update(contextOf('piece'))]);
    expect(host.objects.rows.has('piece')).toBe(false);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(host.objects.rows.has('piece')).toBe(true);

    host.emit(alice, [update(contextOf('piece', 2))]);
    host.engine.closed(alice);
    host.engine.flushNow();

    expect(host.objects.rows.get('piece')?.entry.majorVersion).toBe(2);
    expect(host.events.filter(([event]) => event === 'flush')).toEqual([['flush', '', 2]]);
  });

  it('writes nothing once told to stop', () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const alice = host.join('alice');
    host.emit(alice, [update(contextOf('piece'))]);

    host.engine.stopFlushing();
    vi.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(host.objects.rows.has('piece')).toBe(false);
  });
});

describe('the object index', () => {
  it('goes back to what is kept for an object it could not write', () => {
    const host = new FakeHost();
    const store = host.objects;
    store.put(contextOf('kept', 1, { parentIdentifier: 'table' }), null);
    store.put(contextOf('marked'), null);
    store.flush();
    store.delete('marked', true);
    store.flush();
    store.put(contextOf('kept', 2, { parentIdentifier: 'elsewhere' }), null);
    store.put(contextOf('unkept'), null);
    store.forget(['marked']);

    store.goBack('kept');
    store.goBack('unkept');
    store.goBack('marked');

    expect(store.entryOf('kept')).toMatchObject({ majorVersion: 1, parent: 'table' });
    expect(store.descendantsOf('table')).toEqual(['kept']);
    expect(store.descendantsOf('elsewhere')).toEqual([]);
    expect(store.entryOf('unkept')).toBeNull();
    expect(store.isDeleted('marked')).toBe(true);
  });

  it('follows reactions to a message, and lets go of one taken away', () => {
    const host = new FakeHost();
    const store = host.objects;
    const reaction = (identifier: string, message: string) =>
      contextOf(identifier, 1, { messageIdentifier: message }, 'chat-reaction');
    store.put(contextOf('message', 1, {}, 'chat'), null);
    store.put(reaction('smile', 'message'), null);
    store.put(reaction('frown', 'message'), null);

    store.delete('frown', false);
    store.put(reaction('smile', 'other'), null);

    expect(store.dependentsOf('message')).toEqual([]);
    expect(store.dependentsOf('other')).toEqual(['smile']);
  });

  it('reaches each descendant once, even through a loop of parents', () => {
    const store = new FakeHost().objects;
    store.put(contextOf('a', 1, { parentIdentifier: 'b' }), null);
    store.put(contextOf('b', 1, { parentIdentifier: 'a' }), null);

    expect(store.descendantsOf('a')).toEqual(['b']);
  });
});
