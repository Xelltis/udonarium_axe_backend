import type { PeerRole } from '../../../contracts/protocol.js';
import type { ObjectIndex } from './object-index.js';
import type { PasswordHash } from './password.js';

/**
 * 接続ごとの情報。hello が通るまでは無い。置き場所は部屋のサーバーが決める（Cloudflare 版では
 * WebSocket に添えて置くので、Hibernation から起き直しても残る）
 */
export interface Seat {
  peerId: string;
  userId: string;
  /** 部屋の一覧に人数を知らせるときの鍵 */
  roomKey: string;
  /** サーバーが決めた役割 */
  role: PeerRole;
  /** ログインして入った。ログインしていない人は見学のまま、役割を変えられない */
  account: boolean;
  /** 入った時刻（Unix ミリ秒） */
  joinedAt: number;
  /** ログインして入った人の、アクセストークンが切れる時刻（Unix ミリ秒）。新しいトークンが届けば延びる */
  expiresAt?: number;
  /** サーバーが閉じた（断った、または同じピア ID の新しい接続に替わった） */
  closed?: boolean;
}

/** 部屋について、席を作るのに要ること */
export interface RoomFacts {
  roomKey: string;
  /** パスワードの無い部屋なら null */
  password: PasswordHash | null;
}

/** 部屋の記録に書く出来事 */
export type RoomEvent = 'join' | 'leave' | 'refuse' | 'flush' | 'roll' | 'delete';

/**
 * ログインして入ったことのある人ごとの役割。確かめてから書くまでのあいだに、ほかのメッセージが
 * 割り込まないよう、同期で読み書きする
 */
export interface RoleBook {
  /** 覚えている役割。入ったことが無ければ null */
  roleOf(userId: string): PeerRole | null;
  /** 初めて席に着いた人の役割を覚える */
  add(userId: string, role: PeerRole): void;
  /** 役割を変える */
  set(userId: string, role: PeerRole): void;
  /** GM の数（いま席にいない人も数える） */
  gameMasterCount(): number;
}

/** 部屋のオブジェクトの置き場所。flush は書いた数を返す（記録に使う） */
export interface RoomStore extends ObjectIndex {
  flush(): number;
}

/**
 * 部屋のサーバーが RoomEngine に渡すもの。接続、席、部屋の行、役割、置き場所、時計と一覧と記録。
 * C は接続を表すもの（Cloudflare 版では WebSocket）
 */
export interface RoomHost<C extends object> {
  /** 受けている接続すべて。hello の前のものも、閉じかけのものも入る */
  connections(): readonly C[];
  seatOf(conn: C): Seat | null;
  setSeat(conn: C, seat: Seat): void;
  /** 送る。閉じかけていて送れなければ何もしない */
  send(conn: C, frame: Uint8Array): void;
  /** 閉じる。もう閉じていれば何もしない */
  close(conn: C, code: number, reason: string): void;
  /** 部屋。作られていないか、消しはじめたあとなら null */
  room(): RoomFacts | null;
  /** 部屋を消している最中 */
  wiping(): boolean;
  store(): RoomStore;
  readonly roles: RoleBook;
  /** トークンを確かめ、作る鍵。ログインを置いていなければ null */
  sessionSecret(): string | null;
  /** 人が入った。nextCheckAt までに見回りに来る */
  occupied(nextCheckAt: number): void;
  /** だれもいなくなった。ここから保持期間を数える */
  emptied(): void;
  /** 一覧の人数と GM を直す */
  lobbyChanged(roomKey: string): void;
  record(event: RoomEvent, detail: string, value: number): void;
  /** 返したあとも終わるまで続ける仕事 */
  defer(work: Promise<unknown>): void;
}
