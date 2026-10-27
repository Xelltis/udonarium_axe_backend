import { env, runInDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';

import { RoomStore, migrate } from '../../src/rooms/store';
import { playHour } from './room-model';
import type { Operation, RoomModel } from './room-model';

// Runs what a room's store goes through in a session, and counts the rows SQLite reads and writes (what
// Cloudflare bills), the statements run and the time taken.

export interface Usage {
  read: number;
  written: number;
  statements: number;
  ms: number;
}

/** Counts what run does to SQLite. Every statement's cursor is read once run is over, by then used up. */
export const measure = <T>(sql: SqlStorage, run: () => T): { result: T; usage: Usage } => {
  const exec = sql.exec.bind(sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query, ...bindings) => {
    const cursor = exec(query, ...bindings);
    cursors.push(cursor);
    return cursor;
  });
  const start = performance.now();
  try {
    const result = run();
    const ms = performance.now() - start;
    return {
      result,
      usage: {
        read: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
        written: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
        statements: cursors.length,
        ms,
      },
    };
  } finally {
    spy.mockRestore();
  }
};

/** How many objects a loaded zip brings in before the room writes them (about a second's worth). */
const LOAD_BATCH = 500;

const apply = (store: RoomStore, operation: Operation) => {
  if (operation.kind === 'put') {
    // As the engine does for an update: the version to compare, and whether it was deleted.
    store.entryOf(operation.context.identifier);
    store.isDeleted(operation.context.identifier);
    store.put(operation.context, null);
  } else if (operation.kind === 'delete') {
    for (const identifier of operation.identifiers) store.delete(identifier, true);
  } else {
    store.forget(operation.identifiers);
  }
};

export interface FlowResults {
  /** The GM loads the room's data. */
  load: Usage;
  /** An hour of play, written after each operation (the most writes a 1-second flush can make). */
  playHour: Usage;
  /** Someone comes in with nothing: the catalog, then every object asked for. */
  join: Usage;
  /** The object woke up after being evicted, and someone moves one piece. */
  wake: Usage;
  /** The patrol alarm on a cold object: it looks for cursors of people who are not there. */
  alarm: Usage;
}

/**
 * Runs the flows on a fresh room. A new RoomStore over the same storage stands for the object waking
 * up after eviction: nothing is held in memory, as in a new instance.
 */
export const runFlows = (name: string, model: RoomModel): Promise<FlowResults> =>
  runInDurableObject(env.ROOMS.getByName(name), (_instance, state) => {
    const sql = state.storage.sql;
    migrate(sql);

    const loaded = new RoomStore(state.storage);
    const load = measure(sql, () => {
      model.objects.forEach((context, index) => {
        loaded.put(context, null);
        if ((index + 1) % LOAD_BATCH === 0) loaded.flush();
      });
      loaded.flush();
    }).usage;

    const playing = new RoomStore(state.storage);
    const operations = playHour(model);
    const play = measure(sql, () => {
      for (const operation of operations) {
        apply(playing, operation);
        playing.flush();
      }
    }).usage;

    const joining = new RoomStore(state.storage);
    const join = measure(sql, () => {
      for (const item of joining.catalog()) {
        if (!joining.isDeleted(item.identifier)) joining.get(item.identifier);
      }
    }).usage;

    const waking = new RoomStore(state.storage);
    const moved = operations.find((operation) => operation.kind === 'put') as Operation;
    const wake = measure(sql, () => {
      apply(waking, moved);
      waking.flush();
    }).usage;

    const patrolled = new RoomStore(state.storage);
    const alarm = measure(sql, () => patrolled.owners()).usage;

    return { load, playHour: play, join, wake, alarm };
  });

/** What one statement of each kind costs, on the schema the store uses now. */
export const statementCosts = (name: string) =>
  runInDurableObject(env.ROOMS.getByName(name), (_instance, state) => {
    const sql = state.storage.sql;
    migrate(sql);
    const blob = new ArrayBuffer(500);
    const cost = (query: string, ...bindings: SqlStorageValue[]) => {
      const { usage } = measure(sql, () => sql.exec(query, ...bindings).toArray());
      return { read: usage.read, written: usage.written };
    };
    const insert = 'INSERT INTO objects (identifier, alias, major, minor, parent, data) VALUES (?, ?, 1, 0.5, ?, ?)';
    return {
      'insert a new object': cost(insert, 'a', 'data', '', blob),
      'INSERT OR REPLACE an existing one': cost(
        'INSERT OR REPLACE INTO objects (identifier, alias, major, minor, parent, data) VALUES (?, ?, 2, 0.5, ?, ?)',
        'a',
        'data',
        '',
        blob
      ),
      'upsert an existing one': cost(
        `INSERT INTO objects (identifier, alias, major, minor, parent, data) VALUES (?, ?, 3, 0.5, ?, ?)
         ON CONFLICT(identifier) DO UPDATE SET major = excluded.major, data = excluded.data`,
        'a',
        'data',
        '',
        blob
      ),
      'read one by its key': cost('SELECT data FROM objects WHERE identifier = ?', 'a'),
      'delete chunks that are not there': cost('DELETE FROM object_chunks WHERE identifier = ?', 'a'),
      'delete one': cost('DELETE FROM objects WHERE identifier = ?', 'a'),
      'look at sqlite_master': cost("SELECT name FROM sqlite_master WHERE type = 'table'"),
    };
  });
