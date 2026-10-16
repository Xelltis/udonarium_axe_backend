import type { RoomInit } from '../../src/core/http/backend.js';
import type { RoomEngine } from '../../src/core/rooms/engine.js';
import type { RoomHost } from '../../src/core/rooms/host.js';

// 共有のテストが部屋のサーバーに触るところ。部屋のサーバーごとの test/harness.ts が、これを実装した
// harness を書き出す。共有のテストは、部屋のサーバーの中身にはこれを通してだけ触る

/** つないだ WebSocket を、テストが使う形にしたもの */
export interface TestSocket {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  /** 届いたフレーム。バイナリは ArrayBuffer で渡す */
  onMessage(listener: (data: ArrayBuffer | string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
}

/** WebSocket につなぎ替える要求の結果 */
export interface Upgraded {
  status: number;
  /** つながったときだけ。断られたときは null で、本文は json で読む */
  socket: TestSocket | null;
  json(): Promise<unknown>;
}

/** 置き場所にある部屋のアセット */
export interface StoredAsset {
  /** 置いたときに先頭のバイトで決めた形式 */
  type: string | undefined;
  size: number;
  /** 引用符付きの ETag。GET の ETag と同じもの */
  etag: string;
  /** 置いた時刻（Unix ミリ秒） */
  uploadedAt: number;
}

/** 部屋の中。部屋のサーバーが RoomEngine に渡しているもの */
export interface RoomInside {
  engine: RoomEngine<object>;
  host: RoomHost<object>;
}

export interface Harness {
  /** 部屋のサーバーへのリクエスト。送信元の IP は CF-Connecting-IP に書いておく */
  fetch(request: Request): Promise<Response>;
  /**
   * 環境変数を替えた部屋のサーバーへのリクエスト。undefined の変数は置かない。
   * 終わるまで（あとの仕事も）待ってから返す
   */
  fetchWith(request: Request, env: Record<string, string | undefined>): Promise<Response>;
  upgrade(request: Request): Promise<Upgraded>;
  /** 部屋の中で run を動かす。部屋の状態を作ったり確かめたりするのに使う */
  inside<T>(roomKey: string, run: (room: RoomInside) => T | Promise<T>): Promise<T>;
  /** 鍵を決めて部屋を作る。決まった鍵の部屋を使うアセットのテストのため */
  createRoom(init: RoomInit): Promise<void>;
  canUpload(roomKey: string, userId: string): Promise<'ok' | 'room-not-found' | 'not-a-player'>;
  /** 部屋のサーバーから、ログインの設定だけを外す（部屋は残る） */
  dropLogin(roomKey: string): Promise<void>;
  /** 部屋に置いてあるアセット。無ければ null */
  assetStored(roomKey: string, id: string): Promise<StoredAsset | null>;
  /** 運営する人が、その名前のものを置かせないようにする */
  block(id: string): Promise<void>;
  /** アカウントの、ログインから戻ったときのコード（行の ID）を期限切れにする */
  expireLoginCode(accountKey: string, id: string): Promise<void>;
  /** アカウントのリフレッシュトークンを、すべて期限切れにする */
  expireRefreshTokens(accountKey: string): Promise<void>;
}
