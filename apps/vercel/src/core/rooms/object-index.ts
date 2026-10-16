import type { CatalogItem, ObjectContext } from '../../../contracts/protocol.js';
import { describe } from './visibility.js';
import type { ViewEntry } from './visibility.js';

/** 消した印をこれより多くは置かない。超えたら古いものから PRUNED_TOMBSTONES まで減らす */
export const MAX_TOMBSTONES = 100_000;
export const PRUNED_TOMBSTONES = 80_000;

/** 版・持ち主・親・見え方の手がかりだけの、メモリに置く索引 */
export interface StoredEntry extends ViewEntry {
  alias: string;
  majorVersion: number;
  minorVersion: number;
  /** 接続しているあいだだけ置くもの（PeerCursor）なら、その人のピア ID。それ以外は null */
  owner: string | null;
}

/** まだ書いていない変更。undefined の項目は変えない */
export interface PendingWrite {
  /** 置く中身。null なら消す */
  context?: ObjectContext | null;
  owner?: string | null;
  /** true なら tombstone を置き、false なら消す */
  tombstone?: boolean;
}

export interface TombstoneLimits {
  most: number;
  prunedTo: number;
}

/**
 * 部屋のオブジェクトを持つ。置き場所（SQLite や Redis）によらない部分。
 *
 * 版と tombstone は初めて要るときに置き場所から読んでメモリに置き、中身は答えるときにだけ読む。
 * 書き込みは識別子ごとにまとめておき、置き場所ごとの flush でまとめて書く。ドラッグのように同じものが
 * 何度も書き換わっても、書くのは1つで済む。
 */
export abstract class ObjectIndex {
  private entries: Map<string, StoredEntry> | null = null;
  protected tombstones: Set<string> | null = null;
  protected readonly pending = new Map<string, PendingWrite>();

  constructor(
    protected readonly tombstoneLimits: TombstoneLimits = {
      most: MAX_TOMBSTONES,
      prunedTo: PRUNED_TOMBSTONES,
    },
  ) {}

  /** 置いてあるものすべての索引 */
  protected abstract loadEntries(): Iterable<[string, StoredEntry]>;
  /** 置いてある消した印すべて */
  protected abstract loadTombstones(): Iterable<string>;
  /** 置いてある中身。索引にあるものについてだけ尋ねる */
  protected abstract readData(identifier: string): unknown;

  private get index(): Map<string, StoredEntry> {
    return this.load();
  }

  /** 索引を、初めて要るときに置き場所から読む */
  private load(): Map<string, StoredEntry> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    for (const [identifier, entry] of this.loadEntries()) this.remember(identifier, entry);
    return this.entries;
  }

  /**
   * 書けなかったものの索引を、置き場所にあるとおり（entry と、消した印があるか）に戻す。戻さないと、
   * 索引は新しい版のまま中身は古い（または無い）ので、読むと版と中身が食い違うか、中身が見つからずに止まる
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

  /** 親から子へ、発言からリアクションへの引き */
  private readonly children = new Map<string, Set<string>>();
  private readonly followers = new Map<string, Set<string>>();

  /** 索引に置き、親子とリアクションの引きもそろえる */
  private remember(identifier: string, entry: StoredEntry): void {
    this.forgetRelations(identifier);
    (this.entries as Map<string, StoredEntry>).set(identifier, entry);
    if (entry.parent) relate(this.children, entry.parent, identifier);
    if (entry.view?.kind === 'reaction') relate(this.followers, entry.view.message, identifier);
  }

  private forgetRelations(identifier: string): void {
    const entry = this.entries?.get(identifier);
    if (entry?.parent) this.children.get(entry.parent)?.delete(identifier);
    if (entry?.view?.kind === 'reaction')
      this.followers.get(entry.view.message)?.delete(identifier);
  }

  /** 見え方を決めるために、識別子から索引の1行を引く */
  readonly lookup = (identifier: string): StoredEntry | null => this.index.get(identifier) ?? null;

  /**
   * そのオブジェクトの見え方で見え方が変わるもの。子孫（カードの表の絵、タブの発言など）と、
   * 発言へのリアクション
   */
  dependentsOf(identifier: string): string[] {
    return this.reach(identifier, true);
  }

  /** 子孫。親を消すと一緒に消すもの */
  descendantsOf(identifier: string): string[] {
    return this.reach(identifier, false);
  }

  /** いま持っているものすべての識別子 */
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

  /** 持っているものの数 */
  get size(): number {
    return this.index.size;
  }

  entryOf(identifier: string): StoredEntry | null {
    return this.index.get(identifier) ?? null;
  }

  isDeleted(identifier: string): boolean {
    return this.deleted.has(identifier);
  }

  /** 持っているものすべての識別子と版 */
  catalog(): CatalogItem[] {
    return Array.from(this.index, ([identifier, entry]) => ({
      identifier,
      version: entry.majorVersion + entry.minorVersion,
    }));
  }

  /** 中身まで揃えたもの。持っていなければ null */
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

  /** 持っているものを消す。tombstone を置けば、同じ識別子をもう受けない */
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

  /** tombstone を外し、同じ識別子をまた受けるようにする */
  forget(identifiers: readonly string[]): void {
    for (const identifier of identifiers) {
      if (this.deleted.delete(identifier)) this.stage(identifier, { tombstone: false });
    }
  }

  /** その人のあいだだけ置いているもの（その人のカーソル）の識別子 */
  ownedBy(peerId: string): string[] {
    return [...this.index].filter(([, entry]) => entry.owner === peerId).map(([id]) => id);
  }

  /** その人のあいだだけ置いているものを持っている人のピア ID */
  owners(): string[] {
    const owners = new Set<string>();
    for (const entry of this.index.values()) if (entry.owner !== null) owners.add(entry.owner);
    return [...owners];
  }

  /** その人が出たので、その人のあいだだけ置いていたものを消す。消した識別子を返す */
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
   * 消した印が多すぎるとき、減らす数。印はいつまでも残るので、減らさないと、消すたびに増え続ける。
   * 減らさなくてよければ 0
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
