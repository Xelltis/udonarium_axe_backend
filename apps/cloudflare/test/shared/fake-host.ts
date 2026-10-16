import { encode } from '@msgpack/msgpack';

import { PROTOCOL_VERSION } from '../../contracts/protocol.js';
import type {
  AssetUploadPolicy,
  ObjectContext,
  PeerRole,
  ServerMessage,
} from '../../contracts/protocol.js';
import { ACCESS_TOKEN_SECONDS, signToken } from '../../src/core/auth/tokens.js';
import { decodeFrame } from '../../src/core/rooms/codec.js';
import { RoomEngine } from '../../src/core/rooms/engine.js';
import type {
  RoleBook,
  RoomEvent,
  RoomFacts,
  RoomHost,
  RoomStore,
  Seat,
} from '../../src/core/rooms/host.js';
import { ObjectIndex } from '../../src/core/rooms/object-index.js';
import type { StoredEntry } from '../../src/core/rooms/object-index.js';
import { describe } from '../../src/core/rooms/visibility.js';

// RoomEngine を、部屋のサーバー抜きで動かすための、メモリだけの部屋。どちらの部屋のサーバーでも、
// 部屋のサーバーからは起こしにくいこと（消しているあいだに届いたものなど）を確かめるのに使う

export const SECRET = 'fake-host-secret-0123456789abcdefgh';

/** メモリに置く、部屋のオブジェクト */
export class MemoryStore extends ObjectIndex implements RoomStore {
  readonly rows = new Map<string, { entry: StoredEntry; data: unknown }>();
  readonly marks = new Set<string>();

  protected loadEntries(): [string, StoredEntry][] {
    return Array.from(this.rows, ([identifier, row]) => [identifier, row.entry]);
  }

  protected loadTombstones(): Iterable<string> {
    return this.marks;
  }

  protected readData(identifier: string): unknown {
    return this.rows.get(identifier)?.data;
  }

  flush(): number {
    const count = this.pending.size;
    for (const [identifier, write] of this.pending) {
      if (write.context === null) this.rows.delete(identifier);
      else if (write.context) this.rows.set(identifier, rowOf(write.context, write.owner ?? null));
      if (write.tombstone === true) this.marks.add(identifier);
      if (write.tombstone === false) this.marks.delete(identifier);
    }
    this.pending.clear();
    return count;
  }

  /** 書けなかったことにして、索引を置いてあるとおりに戻す */
  goBack(identifier: string): void {
    this.resync(identifier, this.rows.get(identifier)?.entry ?? null, this.marks.has(identifier));
  }
}

const rowOf = (context: ObjectContext, owner: string | null) => ({
  entry: {
    alias: context.aliasName,
    majorVersion: context.majorVersion,
    minorVersion: context.minorVersion,
    owner,
    ...describe(context),
  },
  data: context.syncData,
});

/** メモリの部屋につないだ人 */
export class FakeConn {
  seat: Seat | null = null;
  readonly received: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  /** 届いたうち、その種類のもの */
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }
}

export class FakeHost implements RoomHost<FakeConn> {
  readonly conns: FakeConn[] = [];
  facts: RoomFacts | null = { roomKey: 'room', password: null };
  deleting = false;
  readonly objects = new MemoryStore();
  readonly roleMap = new Map<string, PeerRole>();
  readonly events: [RoomEvent, string, number][] = [];
  /** 人が入った・いなくなった・一覧を直す、の知らせ */
  readonly notices: string[] = [];
  readonly deferred: Promise<unknown>[] = [];
  /** welcome で知らせるアセットの置き方。Vercel 版のように、本文に上限のある部屋のサーバーにしておく */
  policy: AssetUploadPolicy | null = { maxPutBytes: 4_000_000, directUpload: true };
  readonly engine = new RoomEngine<FakeConn>(this);

  connections(): FakeConn[] {
    return this.conns;
  }

  seatOf(conn: FakeConn): Seat | null {
    return conn.seat;
  }

  setSeat(conn: FakeConn, seat: Seat): void {
    conn.seat = seat;
  }

  send(conn: FakeConn, frame: Uint8Array): void {
    conn.received.push(decodeFrame(frame) as ServerMessage);
  }

  close(conn: FakeConn, code: number, reason: string): void {
    conn.closed = { code, reason };
  }

  room(): RoomFacts | null {
    return this.facts;
  }

  wiping(): boolean {
    return this.deleting;
  }

  store(): MemoryStore {
    return this.objects;
  }

  readonly roles: RoleBook = {
    roleOf: (userId) => this.roleMap.get(userId) ?? null,
    add: (userId, role) => void this.roleMap.set(userId, role),
    set: (userId, role) => void this.roleMap.set(userId, role),
    gameMasterCount: () => [...this.roleMap.values()].filter((role) => role === 'gm').length,
  };

  sessionSecret(): string | null {
    return SECRET;
  }

  assetUploadPolicy(): AssetUploadPolicy | null {
    return this.policy;
  }

  occupied(): void {
    this.notices.push('occupied');
  }

  emptied(): void {
    this.notices.push('emptied');
  }

  lobbyChanged(): void {
    this.notices.push('lobby');
  }

  record(event: RoomEvent, detail: string, value: number): void {
    this.events.push([event, detail, value]);
  }

  defer(work: Promise<unknown>): void {
    this.deferred.push(work);
  }

  /** つないで、部屋に受けさせる */
  connect(): FakeConn {
    const conn = new FakeConn();
    this.conns.push(conn);
    this.engine.accept(conn);
    return conn;
  }

  /** つないで、ログインした `user-<peerId>` として入る */
  join(peerId: string, role: PeerRole = 'pl'): FakeConn {
    const conn = this.connect();
    this.hello(conn, peerId, role);
    return conn;
  }

  /** ログインした `user-<peerId>` として hello を送る */
  hello(conn: FakeConn, peerId: string, role: PeerRole = 'pl'): void {
    const userId = `user-${peerId}`;
    this.roleMap.set(userId, role);
    this.engine.receive(
      conn,
      encode({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        peerId,
        userId,
        accessToken: signToken<'access'>(
          { aud: 'access', sub: `discord:${peerId}`, uid: userId, name: peerId },
          ACCESS_TOKEN_SECONDS,
          SECRET,
        ),
      }),
    );
  }

  /** 部屋にイベントを送る */
  emit(conn: FakeConn, events: { eventName: string; data: unknown }[], to?: string): void {
    this.engine.receive(
      conn,
      encode({ type: 'send', ...(to === undefined ? {} : { to }), events }),
    );
  }
}
