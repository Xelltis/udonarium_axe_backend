import type { CatalogItem, ObjectContext } from '../../../contracts/protocol.js';
import { describe } from './visibility.js';
import type { ViewEntry } from './visibility.js';

/** No more tombstones than this are kept. Past it, the oldest go until PRUNED_TOMBSTONES are left. */
export const MAX_TOMBSTONES = 100_000;
export const PRUNED_TOMBSTONES = 80_000;

/** The index kept in memory, holding only the version, the owner, the parent and the view hint. */
export interface StoredEntry extends ViewEntry {
  alias: string;
  majorVersion: number;
  minorVersion: number;
  /** For what is kept only while someone is connected (PeerCursor), that person's peer id. Null otherwise. */
  owner: string | null;
}

/** A change not written yet. A field left undefined is not changed. */
export interface PendingWrite {
  /** The contents to store, or null to delete them. */
  context?: ObjectContext | null;
  owner?: string | null;
  /** True stores a tombstone, and false deletes it. */
  tombstone?: boolean;
}

export interface TombstoneLimits {
  most: number;
  prunedTo: number;
}

/**
 * Holds the room's objects. This is the part that does not depend on the store (SQLite or Redis).
 *
 * Versions and tombstones are read from the store into memory when they are first needed, and the
 * contents are read only when answering. Writes are gathered by identifier and written together by
 * each store's flush. Even when the same object is rewritten many times, as in a drag, only one
 * write is needed.
 */
export abstract class ObjectIndex {
  private entries: Map<string, StoredEntry> | null = null;
  protected tombstones: Set<string> | null = null;
  protected readonly pending = new Map<string, PendingWrite>();

  constructor(
    protected readonly tombstoneLimits: TombstoneLimits = {
      most: MAX_TOMBSTONES,
      prunedTo: PRUNED_TOMBSTONES,
    }
  ) {}

  /** The index of everything stored. */
  protected abstract loadEntries(): Iterable<[string, StoredEntry]>;
  /** Every tombstone stored. */
  protected abstract loadTombstones(): Iterable<string>;
  /** The stored contents. It is asked only about what is in the index. */
  protected abstract readData(identifier: string): unknown;

  private get index(): Map<string, StoredEntry> {
    return this.load();
  }

  /** Reads the index from the store when it is first needed. */
  private load(): Map<string, StoredEntry> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    for (const [identifier, entry] of this.loadEntries()) this.remember(identifier, entry);
    return this.entries;
  }

  /**
   * Puts the index of what could not be written back to how the store has it (entry, and whether
   * there is a tombstone). Otherwise the index would keep the new version while the contents stay
   * old (or missing), so a read would find the version and the contents at odds, or stop on
   * contents it cannot find.
   */
  protected resync(identifier: string, entry: StoredEntry | null, tombstone: boolean): void {
    if (entry) {
      this.remember(identifier, entry);
    } else {
      this.forgetRelations(identifier);
      this.index.delete(identifier);
    }
    if (tombstone) this.deleted.add(identifier);
    else this.deleted.delete(identifier);
  }

  /** The links from parent to child, and from message to reaction. */
  private readonly children = new Map<string, Set<string>>();
  private readonly followers = new Map<string, Set<string>>();

  /** Puts an entry in the index, and brings the parent and child links and reaction links in line. */
  private remember(identifier: string, entry: StoredEntry): void {
    this.forgetRelations(identifier);
    (this.entries as Map<string, StoredEntry>).set(identifier, entry);
    if (entry.parent) relate(this.children, entry.parent, identifier);
    if (entry.view?.kind === 'reaction') relate(this.followers, entry.view.message, identifier);
  }

  private forgetRelations(identifier: string): void {
    const entry = this.entries?.get(identifier);
    if (entry?.parent) this.children.get(entry.parent)?.delete(identifier);
    if (entry?.view?.kind === 'reaction') this.followers.get(entry.view.message)?.delete(identifier);
  }

  /** Looks up an index row by identifier, to decide the view. */
  readonly lookup = (identifier: string): StoredEntry | null => this.index.get(identifier) ?? null;

  /**
   * What changes view with the object's view: its descendants (a card's face picture, a tab's
   * messages and so on) and the reactions to a message.
   */
  dependentsOf(identifier: string): string[] {
    return this.reach(identifier, true);
  }

  /** The descendants: what is deleted along with the parent. */
  descendantsOf(identifier: string): string[] {
    return this.reach(identifier, false);
  }

  /** The identifiers of everything held now. */
  identifiers(): string[] {
    return [...this.load().keys()];
  }

  private reach(identifier: string, withFollowers: boolean): string[] {
    this.load();
    const found = new Set<string>();
    const queue = [identifier];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const next = [
        ...(this.children.get(current) ?? []),
        ...(withFollowers ? (this.followers.get(current) ?? []) : []),
      ];
      for (const id of next) {
        if (id === identifier || found.has(id)) continue;
        found.add(id);
        queue.push(id);
      }
    }
    return [...found];
  }

  private get deleted(): Set<string> {
    this.tombstones ??= new Set(this.loadTombstones());
    return this.tombstones;
  }

  /** How many objects are held. */
  get size(): number {
    return this.index.size;
  }

  entryOf(identifier: string): StoredEntry | null {
    return this.index.get(identifier) ?? null;
  }

  isDeleted(identifier: string): boolean {
    return this.deleted.has(identifier);
  }

  /** The identifier and version of everything held. */
  catalog(): CatalogItem[] {
    return Array.from(this.index, ([identifier, entry]) => ({
      identifier,
      version: entry.majorVersion + entry.minorVersion,
    }));
  }

  /** The object with its contents filled in, or null when it is not held. */
  get(identifier: string): ObjectContext | null {
    const entry = this.index.get(identifier);
    if (!entry) return null;
    const waiting = this.pending.get(identifier)?.context;
    if (waiting) return waiting;
    return {
      aliasName: entry.alias,
      identifier,
      majorVersion: entry.majorVersion,
      minorVersion: entry.minorVersion,
      syncData: this.readData(identifier) as Record<string, unknown>,
    };
  }

  put(context: ObjectContext, owner: string | null): void {
    this.load();
    this.remember(context.identifier, {
      alias: context.aliasName,
      majorVersion: context.majorVersion,
      minorVersion: context.minorVersion,
      owner,
      ...describe(context),
    });
    this.stage(context.identifier, { context, owner });
  }

  /** Deletes something held. With a tombstone, the same identifier is not taken again. */
  delete(identifier: string, tombstone: boolean): void {
    this.load();
    this.forgetRelations(identifier);
    this.index.delete(identifier);
    this.stage(identifier, { context: null });
    if (tombstone) {
      this.deleted.add(identifier);
      this.stage(identifier, { tombstone: true });
    }
  }

  /** Removes the tombstones, so that the same identifiers are taken again. */
  forget(identifiers: readonly string[]): void {
    for (const identifier of identifiers) {
      if (this.deleted.delete(identifier)) this.stage(identifier, { tombstone: false });
    }
  }

  /** The identifiers of what is kept only while that person is there (their cursor). */
  ownedBy(peerId: string): string[] {
    return [...this.index].filter(([, entry]) => entry.owner === peerId).map(([id]) => id);
  }

  /** The peer ids of those who have something kept only while they are there. */
  owners(): string[] {
    const owners = new Set<string>();
    for (const entry of this.index.values()) if (entry.owner !== null) owners.add(entry.owner);
    return [...owners];
  }

  /** The person has left, so deletes what was kept only while they were there. Returns the identifiers deleted. */
  removeOwnedBy(peerId: string): string[] {
    const owned = this.ownedBy(peerId);
    for (const identifier of owned) this.delete(identifier, false);
    return owned;
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  private stage(identifier: string, write: PendingWrite): void {
    this.pending.set(identifier, { ...this.pending.get(identifier), ...write });
  }

  /**
   * How many tombstones to cut when there are too many. Tombstones stay forever, so without cutting
   * they would keep growing with every deletion. It is 0 when none need cutting.
   */
  protected tombstonesOver(): number {
    if (!this.tombstones || this.tombstones.size <= this.tombstoneLimits.most) return 0;
    return this.tombstones.size - this.tombstoneLimits.prunedTo;
  }
}

const relate = (relations: Map<string, Set<string>>, from: string, to: string): void => {
  const set = relations.get(from) ?? new Set<string>();
  set.add(to);
  relations.set(from, set);
};
