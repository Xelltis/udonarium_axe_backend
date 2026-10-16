import type { Account, DirectUploadTarget, RoomAsset, RoomSummary } from '../../../contracts/protocol.js';
import type { Profile, Secret, Session } from '../auth/secrets.js';
import type { LoginConfig } from '../config/login.js';

/** 部屋のサーバーの経路が要る設定。部屋のサーバーごとの設定は、これに足して持つ */
export interface ServerConfig {
  /** 部屋とアセットとログインを受ける Origin */
  allowedOrigins: string[];
  login: LoginConfig | null;
}

/** 部屋を作るときに渡すもの */
export interface RoomInit {
  roomKey: string;
  roomId: string;
  name: string;
  /** 空ならパスワードの無い部屋 */
  password: string;
  /** 部屋を作った人のユーザー ID。この人が GM になる */
  creatorUserId: string;
  /** 受けたホスト名。同じ置き場所を使う別のインスタンスと、記録を分けるのに使う */
  host: string;
}

/** 送信元ごとに数を絞るもの。上限は部屋のサーバーが決める */
export type LimitKind = 'upload' | 'read' | 'room' | 'auth';

/** ログインした1人ぶんのアカウント */
export interface AccountPort {
  signIn(profile: Profile, challenge: string): Promise<Secret>;
  redeem(code: Secret, verifier: string): Promise<Session | null>;
  refresh(token: Secret): Promise<Session | null>;
  signOut(token: Secret): Promise<void>;
  account(): Promise<Account | null>;
  erase(userId: string): Promise<boolean>;
}

/** 部屋のアセットの置き場所 */
export interface AssetBackend {
  /** 運営する人が置かせないようにしたものか */
  blocked(id: string): Promise<boolean>;
  /** その部屋にもう置いてあるか */
  exists(roomKey: string, id: string): Promise<boolean>;
  /**
   * 置く。body は先頭から流れてくる中身で、length バイトのはず。中身のハッシュが id と合わなければ
   * 置かずに 'hash-mismatch'
   */
  store(
    roomKey: string,
    id: string,
    body: ReadableStream<Uint8Array>,
    length: number,
    type: string,
    name: string
  ): Promise<'stored' | 'hash-mismatch'>;
  /** 置いたものを取り除く（置いているあいだに部屋が消えたとき） */
  discard(roomKey: string, id: string): Promise<void>;
  /** GET の応答。トークンは確かめてある。レート制限と条件付きリクエストと Range はここで扱う */
  read(request: Request, roomKey: string, id: string): Promise<Response>;
  /** HEAD の応答。トークンは確かめてある */
  head(request: Request, roomKey: string, id: string): Promise<Response>;
  /** その部屋に置いてあるもの */
  list(roomKey: string): Promise<RoomAsset[]>;
  /** 新しく置いたあとのついでの仕事（消しそこねの掃除など） */
  afterStore(): void;
  /** 置き場所へ直接上げる流れ。1回の要求の本文に上限のある部屋のサーバー（Vercel 版）だけが持つ */
  direct?: DirectUploads;
}

/** 置き場所へ直接上げる流れ。仮置きへ上げさせ、確かめてから部屋のアセットにする */
export interface DirectUploads {
  /** 1回の PUT で受けるバイト数の上限。これを超えるものは、直接上げてもらう */
  maxPutBytes: number;
  /** 仮置きの場所へ、size バイトまでを一度だけ上げさせる先を作る */
  target(path: string, size: number): Promise<DirectUploadTarget>;
  /** 仮置きの中身を流す。無ければ（まだ上げていないか、掃除で消えた）null */
  open(path: string): Promise<ReadableStream<Uint8Array> | null>;
  /** 仮置きを消す */
  discard(path: string): Promise<void>;
}

/**
 * 部屋のサーバーが、共有の経路に渡すもの。リクエストごとに作り、Request だけを受ける
 */
export interface ServerBackend {
  /** 送信元ごとに数える上限のうちか */
  limit(request: Request, kind: LimitKind): Promise<boolean>;
  lobby: {
    /** 部屋の一覧。userId を渡せば、その人が GM の部屋に deletable を付ける */
    list(userId?: string): Promise<RoomSummary[]>;
    find(roomKey: string, userId?: string): Promise<RoomSummary | null>;
  };
  rooms: {
    create(init: RoomInit): Promise<void>;
    remove(roomKey: string, userId: string): Promise<'deleted' | 'not-found' | 'not-game-master'>;
    canUpload(roomKey: string, userId: string): Promise<'ok' | 'room-not-found' | 'not-a-player'>;
    /** 部屋の WebSocket につなぐ。Origin とレート制限は確かめてある */
    connect(request: Request, roomKey: string): Promise<Response>;
  };
  account(accountKey: string): AccountPort;
  assets: AssetBackend;
}

/** 共有の経路の Hono の型。config と backend は部屋のサーバーが先に置く */
export interface ServerEnv {
  Variables: { config: ServerConfig; backend: ServerBackend };
}
