/**
 * サーバー版の部屋（apps/cloudflare の RoomDurableObject）と Udonarium Axe のあいだのプロトコル。
 *
 * このファイルはサーバー側が持ち主で、クライアントは同じ内容を写して使う。npm には出さない。
 * 両側のテストが fixtures/ の同じ JSON を読み、判定が食い違わないことを確かめる。
 *
 * WebSocket のフレームはバイナリで、中身は下の封筒（ClientMessage と ServerMessage）を
 * MessagePack にしたもの。フレーム全体を gzip してもよい（先頭が 1f 8b なら gzip とみなす）。
 * テキストのフレームは、生きているかの確認（`ping` に `pong` が返る）にだけ使う。
 */

/** 封筒の形を変えたら上げる。hello の版が違えば、サーバーは protocol-mismatch で断る */
export const PROTOCOL_VERSION = 1;

/**
 * 部屋のサーバー自身のピア ID。クライアントの ID とぶつからない形にしてある。
 * クライアントは、ほかのメンバーと並べてこのピアがいるものとして扱い、カタログの交換をこのピアとだけ行う。
 */
export const AUTHORITY_PEER_ID = '@authority';

/** 生きているかの確認。テキストのフレームで送ると、サーバーを起こさずに PONG が返る */
export const PING = 'ping';
export const PONG = 'pong';

/** 部屋の名前の最長（文字数）。クライアントの入力欄と揃える */
export const MAX_ROOM_NAME_LENGTH = 255;
/** 部屋のパスワードの最長（文字数） */
export const MAX_PASSWORD_LENGTH = 64;
/** 1つの部屋に同時に入れる人数 */
export const MAX_MEMBERS = 32;

/** クライアントどうしで交わすイベント。中身はサーバーが読むものを除いて、そのまま届ける */
export interface EventContext {
  eventName: string;
  data: unknown;
  /** 送り主のピア ID。サーバーが、受けた接続のピア ID で上書きする */
  sendFrom: string;
}

/** 部屋にいる人 */
export interface Member {
  peerId: string;
  userId: string;
}

// ---- クライアントからサーバーへ ----

/** 接続して最初に送るもの。これより前のものは受けない */
export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** 今と同じ形のピア ID（ユーザー・部屋・パスワードのダイジェストから作る） */
  peerId: string;
  userId: string;
  /** パスワードのある部屋に入るとき */
  password?: string;
}

/** イベントの束を送る。to を付ければその人にだけ、付けなければ自分以外の全員に届く */
export interface SendMessage {
  type: 'send';
  to?: string;
  events: EventContext[];
}

/** サーバーの時刻を尋ねる。時計のずれを測るのに使う */
export interface TimeRequest {
  type: 'time';
}

export type ClientMessage = HelloMessage | SendMessage | TimeRequest;

// ---- サーバーからクライアントへ ----

/** hello が通ったときの返事。続けてサーバーのカタログが届く */
export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
  /** 受け付けたピア ID */
  peerId: string;
  authorityPeerId: string;
  /** 自分以外の、いま部屋にいる人 */
  members: Member[];
  /** サーバーの時刻（Unix ミリ秒） */
  serverTime: number;
}

/** だれかが部屋に入った */
export interface JoinMessage {
  type: 'join';
  member: Member;
}

/** だれかが部屋を出た（接続が切れた） */
export interface LeaveMessage {
  type: 'leave';
  peerId: string;
}

/** イベントの束。from は送り主のピア ID で、サーバー自身なら AUTHORITY_PEER_ID */
export interface DataMessage {
  type: 'data';
  from: string;
  events: EventContext[];
}

export interface TimeMessage {
  type: 'time';
  serverTime: number;
}

/**
 * 接続を閉じる理由。サーバーはこれを送ってから、同じ code を reason にして閉じる。
 * それぞれが起きるときは fixtures/errors.json にある。
 *
 * - protocol-mismatch：hello の版がサーバーと違う
 * - room-not-found：部屋が無い（作られていないか、保持期間を過ぎて消えた）
 * - room-full：部屋の人数が MAX_MEMBERS に達している
 * - wrong-password：パスワードが違う
 * - hello-required：最初のメッセージが hello でない
 * - bad-message：読めないメッセージを送った
 * - too-many-messages：短いあいだに送りすぎた
 * - replaced：同じピア ID で新しく接続した人がいるので、こちらを閉じる。つなぎ直さないこと
 */
export const ERROR_CODES = [
  'protocol-mismatch',
  'room-not-found',
  'room-full',
  'wrong-password',
  'hello-required',
  'bad-message',
  'too-many-messages',
  'replaced',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  protocolVersion?: number;
}

export type ServerMessage =
  WelcomeMessage | JoinMessage | LeaveMessage | DataMessage | TimeMessage | ErrorMessage;

/** サーバーが閉じるときの WebSocket の close code */
export const CLOSE_CODE = 4000;

// ---- HTTP ----

/** POST /v1/rooms の本文 */
export interface CreateRoomRequest {
  name: string;
  password?: string;
}

/** POST /v1/rooms の返事（201） */
export interface CreateRoomResponse {
  /** 部屋の鍵。GET /v1/rooms/:roomKey/ws で入るときと、招待リンクに使う */
  roomKey: string;
  /** 表示用の3文字の ID */
  roomId: string;
}

/** GET /v1/rooms の1行 */
export interface RoomSummary {
  roomKey: string;
  roomId: string;
  name: string;
  hasPassword: boolean;
  /** いま入っている人数 */
  members: number;
}

export interface RoomListResponse {
  rooms: RoomSummary[];
}

// ---- 同期 ----

/**
 * サーバーが中身を読むイベント。ほかのイベントは中身を読まずに届ける。
 *
 * - UPDATE と DELETE は、宛先にかかわらずサーバーの持つ状態に当ててから、送り主以外の全員に配る
 * - CATALOG・REQUEST・REQUEST_CATALOG は、宛先がサーバー（または宛先なし）ならサーバーが答える
 * - FORGET_DELETED は、サーバーの tombstone も消してから全員に配る
 */
export const SyncEvent = {
  UPDATE: 'UPDATE_GAME_OBJECT',
  DELETE: 'DELETE_GAME_OBJECT',
  CATALOG: 'SYNCHRONIZE_GAME_OBJECT',
  REQUEST: 'REQUEST_GAME_OBJECT',
  REQUEST_CATALOG: 'REQUEST_CATALOG',
  FORGET_DELETED: 'FORGET_DELETED_OBJECTS',
} as const;

/**
 * 接続しているあいだだけ置くオブジェクトの種類。syncData.peerId の人が部屋にいるあいだだけ持ち、
 * その人が出たら消す（DELETE は配らない。クライアントが leave を受けて自分で片付ける）。tombstone も残さない
 */
export const PEER_CURSOR_ALIAS = 'PeerCursor';

/** UPDATE_GAME_OBJECT の data。サーバーは syncData を読まずに、そのまま置いて返す */
export interface ObjectContext {
  aliasName: string;
  identifier: string;
  majorVersion: number;
  minorVersion: number;
  syncData: Record<string, unknown>;
}

/** SYNCHRONIZE_GAME_OBJECT の data の1件。version は majorVersion + minorVersion */
export interface CatalogItem {
  identifier: string;
  version: number;
}

/** SYNCHRONIZE_GAME_OBJECT の1件に入れる最大の件数。クライアントと揃える */
export const CATALOG_BATCH = 2048;

/** 同期するオブジェクトの版。majorVersion + minorVersion の和で比べる（minorVersion は 0 以上 1 未満） */
export interface ObjectVersion {
  majorVersion: number;
  minorVersion: number;
}

/**
 * 届いた UPDATE_GAME_OBJECT をどう扱うか。
 *
 * - accept：持っているものより新しい（または初めて見る）。置き換えて、ほかの人に配る
 * - same：持っているものと同じ版。何もしない
 * - stale：持っているものより古い。持っている方を送り主に送り返す
 * - deleted：消されたオブジェクト。送り主に DELETE_GAME_OBJECT を返す
 */
export type UpdateVerdict = 'accept' | 'same' | 'stale' | 'deleted';

/** 最後に書いたものを勝たせる（LWW）判定。クライアントの ObjectSynchronizer と同じく、和が厳密に大きいときだけ採る */
export const judgeUpdate = (
  stored: ObjectVersion | null,
  incoming: ObjectVersion,
  deleted: boolean,
): UpdateVerdict => {
  if (deleted) return 'deleted';
  if (!stored) return 'accept';
  const storedVersion = stored.majorVersion + stored.minorVersion;
  const incomingVersion = incoming.majorVersion + incoming.minorVersion;
  if (incomingVersion > storedVersion) return 'accept';
  return incomingVersion === storedVersion ? 'same' : 'stale';
};
