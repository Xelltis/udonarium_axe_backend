import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ASSET_OWNER_ALIAS,
  ASSET_OWNER_PREFIX,
  ASSET_REMOVAL_ALIAS,
  ASSET_REMOVAL_PREFIX,
  AuthorityEvent,
  CHAT_TAB_LIST_IDENTIFIER,
  CLOSE_CODE,
  IMAGE_TAG_LOCK_ALIAS,
  IMAGE_TAG_LOCK_PREFIX,
  SyncEvent,
} from '../../contracts/protocol.js';
import { FLUSH_DELAY_MS, MAX_FRAMES_PER_WINDOW } from '../../src/core/rooms/limits.js';
import { FakeHost } from './fake-host.js';
import type { FakeConn } from './fake-host.js';

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
    expect(host.engine.canDiscard('user-seated', 'a'.repeat(64))).toBe('room-not-found');
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

describe('pings passed on from a socket on another instance', () => {
  it('counts them as frames, and closes the connection once over the limit', () => {
    const host = new FakeHost();
    const conn = host.join('alice');

    const answered = Array.from({ length: MAX_FRAMES_PER_WINDOW + 1 }, () => host.engine.takeRelayedPing(conn));

    expect(answered[0]).toBe(true);
    expect(answered.at(-1)).toBe(false);
    expect(conn.closed?.reason).toBe('too-many-messages');
    expect(host.engine.takeRelayedPing(conn)).toBe(false);
  });
});

describe('the records of the room’s pictures and sounds', () => {
  const SHA = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const ownerId = (sha: string) => `${ASSET_OWNER_PREFIX}${sha}`;
  const removalId = (sha: string) => `${ASSET_REMOVAL_PREFIX}${sha}`;
  const lockId = (tag: string) => `${IMAGE_TAG_LOCK_PREFIX}${encodeURIComponent(tag)}`;
  const ownerOf = (sha: string, owner: string, majorVersion = 1, identifier = ownerId(sha)) =>
    contextOf(
      identifier,
      majorVersion,
      { attributes: { assetIdentifier: sha, kind: 'image', owner } },
      ASSET_OWNER_ALIAS
    );
  const removalOf = (sha: string, majorVersion = 1, removed = '1', identifier = removalId(sha)) =>
    contextOf(
      identifier,
      majorVersion,
      { attributes: { assetIdentifier: sha, kind: 'image', removed } },
      ASSET_REMOVAL_ALIAS
    );
  const lockOf = (tag: string, owner: string, locked: string, majorVersion = 1, identifier = lockId(tag)) =>
    contextOf(identifier, majorVersion, { attributes: { tag, owner, locked } }, IMAGE_TAG_LOCK_ALIAS);
  const remove = (identifier: string, aliasName = ASSET_REMOVAL_ALIAS) => ({
    eventName: SyncEvent.DELETE,
    data: { aliasName, identifier },
  });
  /** What the server sent back to the one who wrote, by event name. */
  const answers = (conn: FakeConn) =>
    conn
      .of('data')
      .flatMap((message) => message.events)
      .map((event) => event.eventName);
  /** The version the room keeps of the object, or null when it keeps none. */
  const stored = (host: FakeHost, identifier: string) => {
    host.engine.flushNow();
    return host.objects.rows.get(identifier)?.entry.majorVersion ?? null;
  };
  /** A room with a GM, two players and a guest, none of whom has heard anything yet. */
  const table = () => {
    const host = new FakeHost();
    const gm = host.join('gm', 'gm');
    const pl = host.join('pl');
    const other = host.join('other');
    const guest = host.join('guest', 'guest');
    for (const conn of [gm, pl, other, guest]) conn.received.splice(0);
    return { host, gm, pl, other, guest };
  };

  describe('who added a picture or sound', () => {
    it('is made by a player naming themselves alone, and the first to make it keeps it', () => {
      const { host, pl, other, guest } = table();

      host.emit(pl, [update(ownerOf(SHA, 'user-other'))]);
      host.emit(guest, [update(ownerOf(SHA, 'user-guest'))]);
      expect(stored(host, ownerId(SHA))).toBeNull();

      host.emit(pl, [update(ownerOf(SHA, 'user-pl'))]);
      expect(stored(host, ownerId(SHA))).toBe(1);
      host.emit(pl, [update(ownerOf(SHA, 'user-pl', 2))]);
      expect(stored(host, ownerId(SHA))).toBe(2);
      host.emit(other, [update(ownerOf(SHA, 'user-other', 3))]);
      expect(stored(host, ownerId(SHA))).toBe(2);
      expect(answers(other).at(-1)).toBe(AuthorityEvent.AUTHORITATIVE);
    });

    it('sits at the identifier of the asset it names', () => {
      const { host, pl } = table();

      host.emit(pl, [
        update(ownerOf(SHA, 'user-pl', 1, ownerId(OTHER))),
        update(
          contextOf(ownerId(SHA), 1, { attributes: { assetIdentifier: '', owner: 'user-pl' } }, ASSET_OWNER_ALIAS)
        ),
      ]);

      expect(answers(pl)).toEqual([AuthorityEvent.WITHDRAW, AuthorityEvent.WITHDRAW]);
    });

    it('is taken by a player when it names nobody, and changed to name another by the GM alone', () => {
      const { host, gm, pl, other } = table();
      host.emit(gm, [update(ownerOf(SHA, ''))]);

      host.emit(pl, [update(ownerOf(SHA, 'user-pl', 2))]);
      expect(stored(host, ownerId(SHA))).toBe(2);

      host.emit(gm, [update(ownerOf(SHA, 'user-other', 3))]);
      expect(stored(host, ownerId(SHA))).toBe(3);
      host.emit(other, [update(ownerOf(SHA, 'user-other', 4))]);
      expect(stored(host, ownerId(SHA))).toBe(4);
    });

    it('is deleted by the GM alone', () => {
      const { host, gm, pl } = table();
      host.emit(pl, [update(ownerOf(SHA, 'user-pl'))]);

      host.emit(pl, [remove(ownerId(SHA), ASSET_OWNER_ALIAS)]);
      expect(stored(host, ownerId(SHA))).toBe(1);

      host.emit(gm, [remove(ownerId(SHA), ASSET_OWNER_ALIAS)]);
      expect(stored(host, ownerId(SHA))).toBeNull();
    });
  });

  describe('a picture or sound taken out of the room', () => {
    it('is made, put back and deleted by the GM', () => {
      const { host, gm } = table();

      host.emit(gm, [update(removalOf(SHA))]);
      expect(stored(host, removalId(SHA))).toBe(1);
      host.emit(gm, [update(removalOf(SHA, 2, ''))]);
      expect(stored(host, removalId(SHA))).toBe(2);

      host.emit(gm, [remove(removalId(SHA))]);
      expect(stored(host, removalId(SHA))).toBeNull();
    });

    it('is marked removed by the player the room says added it, but not put back nor deleted', () => {
      const { host, pl, guest } = table();
      host.emit(pl, [update(ownerOf(SHA, 'user-pl'))]);

      host.emit(pl, [update(removalOf(SHA))]);
      expect(stored(host, removalId(SHA))).toBe(1);
      host.emit(pl, [update(removalOf(SHA, 2, '')), remove(removalId(SHA)), remove(removalId(SHA), '')]);
      host.emit(guest, [remove(removalId(SHA))]);
      expect(stored(host, removalId(SHA))).toBe(1);
      expect(answers(pl).slice(-3)).toEqual(Array(3).fill(AuthorityEvent.AUTHORITATIVE));
    });

    it('is not marked removed by a player for what someone else, or nobody, is said to have added', () => {
      const { host, gm, pl, other } = table();
      host.emit(other, [update(ownerOf(SHA, 'user-other'))]);
      host.emit(gm, [update(ownerOf(OTHER, ''))]);
      pl.received.splice(0);

      host.emit(pl, [
        update(removalOf(SHA)),
        update(removalOf(OTHER)),
        update(removalOf('c'.repeat(64))),
        // Named as another asset's removal, which the player did add.
        update(removalOf(SHA, 1, '1', removalId('d'.repeat(64)))),
      ]);

      expect(answers(pl)).toEqual(Array(4).fill(AuthorityEvent.WITHDRAW));
    });

    it('is not taken for a guest the GM names as the one who added it', () => {
      const { host, gm, guest } = table();
      host.emit(gm, [update(ownerOf(SHA, 'user-guest'))]);

      host.emit(guest, [update(removalOf(SHA))]);

      expect(stored(host, removalId(SHA))).toBeNull();
    });
  });

  describe('a tag of pictures kept to one person', () => {
    it('is locked by a player naming themselves, and changed then by them and the GM alone', () => {
      const { host, gm, pl, other } = table();

      host.emit(pl, [update(lockOf('boss', 'user-other', '1'))]);
      expect(stored(host, lockId('boss'))).toBeNull();
      host.emit(pl, [update(lockOf('boss', 'user-pl', '1'))]);
      expect(stored(host, lockId('boss'))).toBe(1);

      host.emit(other, [update(lockOf('boss', 'user-pl', '', 2)), update(lockOf('boss', 'user-other', '1', 2))]);
      expect(stored(host, lockId('boss'))).toBe(1);

      host.emit(pl, [update(lockOf('boss', 'user-pl', '', 2))]);
      expect(stored(host, lockId('boss'))).toBe(2);
      host.emit(other, [update(lockOf('boss', 'user-other', '1', 3))]);
      expect(stored(host, lockId('boss'))).toBe(3);

      host.emit(gm, [update(lockOf('boss', 'user-other', '', 4))]);
      expect(stored(host, lockId('boss'))).toBe(4);
    });

    it('sits at the identifier of the tag it names, written as a URI component', () => {
      const { host, pl } = table();

      host.emit(pl, [
        update(lockOf('a b', 'user-pl', '1', 1, `${IMAGE_TAG_LOCK_PREFIX}a b`)),
        update(lockOf('', 'user-pl', '1', 1, IMAGE_TAG_LOCK_PREFIX)),
        update(lockOf('a b', 'user-pl', '1')),
      ]);

      expect(answers(pl).slice(0, 2)).toEqual([AuthorityEvent.WITHDRAW, AuthorityEvent.WITHDRAW]);
      expect(stored(host, lockId('a b'))).toBe(1);
    });

    it('is not written by a guest, and deleted by the GM alone', () => {
      const { host, gm, pl, guest } = table();
      host.emit(guest, [update(lockOf('boss', 'user-guest', '1'))]);
      expect(stored(host, lockId('boss'))).toBeNull();
      host.emit(pl, [update(lockOf('boss', 'user-pl', '1'))]);

      host.emit(pl, [remove(lockId('boss'), IMAGE_TAG_LOCK_ALIAS)]);
      expect(stored(host, lockId('boss'))).toBe(1);

      host.emit(gm, [remove(lockId('boss'), IMAGE_TAG_LOCK_ALIAS)]);
      expect(stored(host, lockId('boss'))).toBeNull();
    });
  });

  it('keeps their identifiers for them, so that no one can take one first or delete one before it is there', () => {
    const { host, gm, pl } = table();
    const kept = [removalId(OTHER), ownerId(OTHER), lockId('boss')];

    host.emit(
      pl,
      kept.flatMap((id) => [update(contextOf(id)), remove(id, '')])
    );
    host.emit(gm, [update(contextOf(`${ASSET_REMOVAL_PREFIX}gm-piece`))]);
    expect(answers(pl)).toEqual(Array(6).fill(AuthorityEvent.WITHDRAW));
    expect(answers(gm)).toEqual([AuthorityEvent.WITHDRAW]);

    host.emit(gm, [
      update(removalOf(OTHER)),
      update(ownerOf(OTHER, 'user-gm')),
      update(lockOf('boss', 'user-gm', '1')),
    ]);
    for (const id of kept) expect(stored(host, id)).toBe(1);
  });

  it('let a player who added an asset take it out of the store, besides the GM', () => {
    const { host, gm, pl } = table();
    host.emit(pl, [update(ownerOf(SHA, 'user-pl'))]);
    host.emit(gm, [update(ownerOf(OTHER, 'user-guest'))]);

    expect(host.engine.canDiscard('user-gm', SHA)).toBe('ok');
    expect(host.engine.canDiscard('user-pl', SHA)).toBe('ok');
    expect(host.engine.canDiscard('user-other', SHA)).toBe('not-game-master');
    expect(host.engine.canDiscard('user-pl', 'c'.repeat(64))).toBe('not-game-master');
    // Named by the GM, but a guest adds nothing.
    expect(host.engine.canDiscard('user-guest', OTHER)).toBe('not-game-master');
    // Someone who has left is not seated.
    host.engine.closed(pl);
    expect(host.engine.canDiscard('user-pl', SHA)).toBe('not-game-master');
  });
});
