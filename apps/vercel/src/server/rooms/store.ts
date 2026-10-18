import { decode, encode } from '@msgpack/msgpack';

import type { ObjectContext } from '../../../contracts/protocol.js';
import { decodeData, encodeData } from '../../core/rooms/codec.js';
import type { RoomStore } from '../../core/rooms/host.js';
import { ObjectIndex } from '../../core/rooms/object-index.js';
import type { StoredEntry, TombstoneLimits } from '../../core/rooms/object-index.js';
import { describe } from '../../core/rooms/visibility.js';
import type { View } from '../../core/rooms/visibility.js';
import type { BinaryRedis, KeyOf } from '../redis.js';
import type { Op } from './fence.js';

// Keeps the room's objects in Redis.
//
//   r:<key>:obj          HASH  identifier → MessagePack of {alias, major, minor, owner, parent, view,
//                              chunks, parts, data}.
//   r:<key>:chunk:<P>    HASH  Contents over 1MiB, split up (number → bytes). P is the row's parts, a
//                              new name each time they are written ("<ID>#<UUID>", or <ID> for rows
//                              written before that).
//   r:<key>:chunked      SET   The P of every set of parts (for when the room is deleted).
//   r:<key>:tomb         ZSET  The tombstones (identifier → when it was deleted).
//
// The instance that owns the room reads everything into memory when it takes the room, and answers
// from memory (because RoomEngine reads without waiting). Writes are gathered first, then written in
// the background, only while this instance is the owner.

/** The limit on the contents kept in one value. Anything over it is kept split up. */
export const CHUNK_BYTES = 1024 * 1024;

/** A stored object. data is the MessagePack of syncData. */
interface Row {
  alias: string;
  major: number;
  minor: number;
  owner: string | null;
  parent: string;
  view: View | null;
  data: Uint8Array;
  /** The name of the key the contents are split up under, or null when they are kept whole. */
  parts: string | null;
}

/**
 * One row kept in Redis. When the contents are split up, chunks holds how many parts and parts
 * where they are, and data is left out.
 */
interface Stored {
  alias: string;
  major: number;
  minor: number;
  owner: string | null;
  parent: string;
  view: View | null;
  chunks: number;
  parts?: string;
  data?: Uint8Array;
}

export interface StoreKeys {
  objects: string;
  chunks: (identifier: string) => string;
  chunked: string;
  tombstones: string;
}

export const storeKeysOf = (key: KeyOf, roomKey: string): StoreKeys => ({
  objects: key('r', roomKey, 'obj'),
  chunks: (identifier) => key('r', roomKey, 'chunk', identifier),
  chunked: key('r', roomKey, 'chunked'),
  tombstones: key('r', roomKey, 'tomb'),
});

const entryOf = (row: Row): StoredEntry => ({
  alias: row.alias,
  majorVersion: row.major,
  minorVersion: row.minor,
  owner: row.owner,
  parent: row.parent,
  view: row.view,
});

/** Deletes a set of split-up contents, when there is one. */
const dropPartsOps = (keys: StoreKeys, parts: string | null): Op[] =>
  parts
    ? [
        { command: 'DEL', key: keys.chunks(parts), args: [] },
        { command: 'SREM', key: keys.chunked, args: [parts] },
      ]
    : [];

const joinParts = (parts: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
};

export class RedisRoomStore extends ObjectIndex implements RoomStore {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly keys: StoreKeys,
    private readonly rows: Map<string, Row>,
    private readonly deletedAt: Map<string, number>,
    private readonly persist: (ops: Op[]) => Promise<void>,
    private readonly strays: Op[],
    tombstoneLimits?: TombstoneLimits
  ) {
    super(tombstoneLimits);
  }

  /**
   * Reads all of the room's objects. persist writes the gathered writes to Redis (it writes only
   * while this instance is the owner).
   */
  static async load(
    redis: BinaryRedis,
    keys: StoreKeys,
    persist: (ops: Op[]) => Promise<void>,
    tombstoneLimits?: TombstoneLimits
  ): Promise<RedisRoomStore> {
    const [objects, tombstones] = await Promise.all([
      redis.hGetAll(keys.objects),
      redis.zRangeWithScores(keys.tombstones, 0, -1),
    ]);
    const rows = new Map<string, Row>();
    const strays: Op[] = [];
    for (const [identifier, value] of Object.entries(objects)) {
      const stored = decode(value) as Stored;
      let data = stored.data as Uint8Array;
      const parts = stored.chunks > 0 ? (stored.parts ?? identifier) : null;
      if (parts) {
        const held = await redis.hGetAll(keys.chunks(parts));
        const pieces = Array.from({ length: stored.chunks }, (_, seq) => held[String(seq)]);
        // An object whose parts are missing is left out, rather than the room never opening again,
        // and taken away with the next write.
        if (pieces.some((part) => part === undefined)) {
          console.error('An object’s parts are missing; it is left out:', identifier);
          strays.push({ command: 'HDEL', key: keys.objects, args: [identifier] }, ...dropPartsOps(keys, parts));
          continue;
        }
        data = joinParts(pieces as Uint8Array[]);
      }
      const { alias, major, minor, owner, parent, view } = stored;
      rows.set(identifier, { alias, major, minor, owner, parent, view, data, parts });
    }
    const deletedAt = new Map(tombstones.map(({ value, score }) => [value.toString(), score] as [string, number]));
    return new RedisRoomStore(keys, rows, deletedAt, persist, strays, tombstoneLimits);
  }

  protected loadEntries(): [string, StoredEntry][] {
    return Array.from(this.rows, ([identifier, row]) => [identifier, entryOf(row)]);
  }

  protected loadTombstones(): Iterable<string> {
    return this.deletedAt.keys();
  }

  protected readData(identifier: string): unknown {
    return decodeData((this.rows.get(identifier) as Row).data);
  }

  /**
   * Applies the changes gathered so far to the copy in memory, then writes them in the background.
   * Returns how many operations it writes.
   * Writes go one at a time, in order. What cannot be written is logged and passed over (when the
   * room's owner changes, the next owner reads everything again).
   */
  flush(): number {
    const ops: Op[] = this.strays.splice(0);
    for (const [identifier, write] of this.pending) {
      if (write.context === null) {
        const parts = this.rows.get(identifier)?.parts ?? null;
        this.rows.delete(identifier);
        ops.push({ command: 'HDEL', key: this.keys.objects, args: [identifier] }, ...dropPartsOps(this.keys, parts));
      } else if (write.context !== undefined) {
        ops.push(...this.writeOps(write.context, write.owner ?? null));
      }
      if (write.tombstone !== undefined) ops.push(this.markOp(identifier, write.tombstone));
    }
    this.pending.clear();
    ops.push(...this.pruneOps());
    this.writing = this.writing
      .then(() => this.persist(ops))
      .catch((err: unknown) => console.error('Could not keep the room’s objects:', err));
    return ops.length;
  }

  /** Waits until the writes under way are done. */
  settle(): Promise<void> {
    return this.writing;
  }

  /**
   * The writes of one object. Split-up contents go under a new name first, then the row is changed
   * over to them, then the old parts are deleted. The writes go in batches, so even when they stop
   * partway, the row still points at parts that are all there.
   */
  private writeOps(context: ObjectContext, owner: string | null): Op[] {
    const data = new Uint8Array(encodeData(context.syncData));
    const { parent, view } = describe(context);
    const chunks = data.byteLength > CHUNK_BYTES ? Math.ceil(data.byteLength / CHUNK_BYTES) : 0;
    const parts = chunks > 0 ? `${context.identifier}#${crypto.randomUUID()}` : null;
    const previous = this.rows.get(context.identifier)?.parts ?? null;
    const row: Row = {
      alias: context.aliasName,
      major: context.majorVersion,
      minor: context.minorVersion,
      owner,
      parent,
      view,
      data,
      parts,
    };
    this.rows.set(context.identifier, row);
    const stored: Stored = {
      alias: row.alias,
      major: row.major,
      minor: row.minor,
      owner,
      parent,
      view,
      chunks,
      ...(parts ? { parts } : { data }),
    };
    const ops: Op[] = [];
    if (parts) {
      const partsKey = this.keys.chunks(parts);
      ops.push(
        { command: 'SADD', key: this.keys.chunked, args: [parts] },
        ...Array.from({ length: chunks }, (_, seq): Op => ({
          command: 'HSET',
          key: partsKey,
          args: [String(seq), Buffer.from(data.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES))],
        }))
      );
    }
    ops.push(
      { command: 'HSET', key: this.keys.objects, args: [context.identifier, Buffer.from(encode(stored))] },
      ...dropPartsOps(this.keys, previous)
    );
    return ops;
  }

  private markOp(identifier: string, tombstone: boolean): Op {
    if (!tombstone) {
      this.deletedAt.delete(identifier);
      return { command: 'ZREM', key: this.keys.tombstones, args: [identifier] };
    }
    const now = Date.now();
    this.deletedAt.set(identifier, now);
    return { command: 'ZADD', key: this.keys.tombstones, args: [String(now), identifier] };
  }

  /** When there are too many tombstones, removes the oldest first. */
  private pruneOps(): Op[] {
    const over = this.tombstonesOver();
    if (over === 0) return [];
    const oldest = [...this.deletedAt]
      .sort((a, b) => a[1] - b[1])
      .slice(0, over)
      .map(([identifier]) => identifier);
    for (const identifier of oldest) {
      this.deletedAt.delete(identifier);
      (this.tombstones as Set<string>).delete(identifier);
    }
    return [{ command: 'ZREM', key: this.keys.tombstones, args: oldest }];
  }
}
