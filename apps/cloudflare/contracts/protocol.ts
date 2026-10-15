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
export const PROTOCOL_VERSION = 2;

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

/**
 * 部屋での役割。サーバーが決め、PeerCursor の role もサーバーが上書きする。
 *
 * - gm：部屋を作った人と、GM が gm にした人
 * - pl：ログインして入った人（招待リンクや GM が変えたときを除く）
 * - guest：ログインせずに入った人（見学）。自分のカーソルと、見学者も話せるタブへの発言しか書けない
 */
export const PEER_ROLES = ['gm', 'pl', 'guest'] as const;
export type PeerRole = (typeof PEER_ROLES)[number];

/**
 * ログインした人のユーザー ID の頭。サーバーが `acct_` に続けて UUID を付けて決める。
 * 見学者（トークンの無い hello）は、これで始まる userId を名乗れない（unauthorized で断る）。
 * 見え方はユーザー ID で決まるので、カーソルに見えるほかの人のユーザー ID を名乗れば、
 * その人の手札や秘話が見えてしまうため
 */
export const ACCOUNT_USER_ID_PREFIX = 'acct_';

/** 部屋にいる人 */
export interface Member {
  peerId: string;
  userId: string;
  role: PeerRole;
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
  /**
   * ログインしているときのアクセストークン（POST /v1/auth/token で得たもの）。
   * 付けなければ見学（guest）として入る。付けるなら userId はトークンの userId と同じにする。
   * 付けないなら userId は ACCOUNT_USER_ID_PREFIX で始まってはいけない
   */
  accessToken?: string;
  /** 招待リンクに付いてきた招待。ログインして初めて入るときの役割になる */
  invite?: string;
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

/** 招待を作ってもらう。GM だけが作れる */
export interface InviteRequest {
  type: 'invite';
  role: PeerRole;
}

/**
 * つながったまま、新しいアクセストークンを渡す。ログインして入った席は、アクセストークンが切れてから
 * 1分のうちに新しいものが届かなければ unauthorized で閉じる。Axe はトークンを替えたら送る
 */
export interface AuthMessage {
  type: 'auth';
  accessToken: string;
}

/** 部屋のアセットのトークンを渡し直してもらう。切れる前に頼む。答えは asset-token で届く */
export interface AssetTokenRequest {
  type: 'asset-token';
}

export type ClientMessage =
  HelloMessage | SendMessage | TimeRequest | InviteRequest | AuthMessage | AssetTokenRequest;

// ---- サーバーからクライアントへ ----

/** hello が通ったときの返事。続けてサーバーのカタログが届く */
export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
  /** 受け付けたピア ID */
  peerId: string;
  /** サーバー自身のピア ID。ピア ID の形から推し量らず、この値を使う */
  authorityPeerId: string;
  /** サーバーが決めた自分の役割。自分の PeerCursor の role はこれにする */
  role: PeerRole;
  /** いま部屋にいる人。接続した本人とサーバーは入らない */
  members: Member[];
  /** サーバーの時刻（Unix ミリ秒） */
  serverTime: number;
  /**
   * この部屋のアセット（/v1/rooms/:roomKey/assets/:sha256）を読み書きするトークン。
   * Authorization: Bearer に付ける。読むのはどの役割でもよく、置けるのは GM と PL だけ
   */
  assetToken: string;
  /** assetToken が使えなくなる時刻（Unix ミリ秒）。その前に asset-token で渡し直してもらう */
  assetTokenExpiresAt: number;
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

/**
 * イベントの束。from は送り主のピア ID で、サーバー自身なら AUTHORITY_PEER_ID。
 * サーバーは、ほかの人の束にも自分のイベント（見え方が変わったものの出し入れなど）を差し込むことがある。
 * 誰からのイベントかは、束の from ではなく、イベントごとの sendFrom で見ること
 */
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
 * 招待。invite を招待リンクに載せる。GM でない人が頼んだときは invite と expiresAt が null。
 * 招待は、まだこの部屋に入ったことのないログインした人の役割を決める（入ったことのある人は今の役割のまま）
 */
export interface InviteMessage {
  type: 'invite';
  role: PeerRole;
  invite: string | null;
  /** 招待が使えなくなる時刻（Unix ミリ秒） */
  expiresAt: number | null;
}

/**
 * 部屋のアセットの新しいトークン。asset-token を頼んだときと、役割が変わったときに届く。
 * 今のトークンと入れ替える
 */
export interface AssetTokenMessage {
  type: 'asset-token';
  assetToken: string;
  /** Unix ミリ秒 */
  expiresAt: number;
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
 * - unauthorized：アクセストークンが無効か期限切れ、または userId がトークンと違う。トークンを更新してつなぎ直す。
 *   つながったあと、トークンが切れて1分のうちに新しいもの（auth）が届かなかったときも。
 *   トークンを付けずに、ログインした人のユーザー ID（ACCOUNT_USER_ID_PREFIX で始まるもの）を名乗ったときも
 * - room-deleted：GM が部屋を削除した。部屋はもう無いので、つなぎ直さないこと
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
  'unauthorized',
  'room-deleted',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  /** サーバーの版。protocol-mismatch のときに、どの版に合わせればよいかがわかる */
  protocolVersion: number;
}

export type ServerMessage =
  | WelcomeMessage
  | JoinMessage
  | LeaveMessage
  | DataMessage
  | TimeMessage
  | InviteMessage
  | AssetTokenMessage
  | ErrorMessage;

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
  /**
   * アクセストークンを付けて一覧を取った人が、この部屋の GM なら true（そうでなければ付かない）。
   * DELETE /v1/rooms/:roomKey で削除できる部屋
   */
  deletable?: boolean;
}

export interface RoomListResponse {
  rooms: RoomSummary[];
}

/** GET /v1/auth/config。ログインに使える提供元。空なら、このサーバーではログインも部屋も使えない */
export interface AuthConfigResponse {
  providers: 'discord'[];
}

/**
 * POST /v1/auth/token の本文。
 *
 * - login_code：ログインから戻ったときに URL のフラグメント（#login_code=…）に付いてきたコードと、
 *   ログインを始めるときに code_challenge の元にした code_verifier を渡す
 * - refresh_token：アクセストークンが切れる前に、リフレッシュトークンで新しい組に替える。
 *   使ったリフレッシュトークンは使えなくなる。同じものをもう一度使うと、その系統のトークンをすべて無効にする
 */
export type TokenRequest =
  | { grant_type: 'login_code'; code: string; code_verifier: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

/** ログインしている人 */
export interface Account {
  /** ずっと同じユーザー ID（ACCOUNT_USER_ID_PREFIX で始まる）。hello の userId にこれを使う */
  userId: string;
  name: string;
  /** アバターの画像の URL。無ければ null */
  avatarUrl: string | null;
}

/** POST /v1/auth/token の返事 */
export interface TokenResponse {
  /** WebSocket の hello と、Authorization: Bearer に使う */
  accessToken: string;
  /** アクセストークンが使える秒数 */
  expiresIn: number;
  refreshToken: string;
  account: Account;
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
 * サーバーとのあいだだけで使うイベント。
 *
 * - AUTHORITATIVE（サーバーから）：data は ObjectContext。版にかかわらず置き換え、消した印も外す。
 *   書く権限の無い変更を戻させるときと、サーバーが中身を直したものを送り主に渡すときに使う
 * - WITHDRAW（サーバーから）：data は { identifier }。消した印を残さずに、手元から外す。
 *   書く権限の無い人が作ったものを取り下げさせるときに使う
 * - ROLE_REQUEST（サーバーへ）：data は { peerId, role }。GM が、部屋にいる人の役割を変える
 * - ROLE_REJECTED（サーバーから）：data は { peerId, role, reason }。ROLE_REQUEST を断った
 * - ROLL_REQUEST（サーバーへ）：data は RollRequest。サーバーが BCDice で振り、結果の発言を全員に配る
 * - ROLL_REJECTED（サーバーから）：data は { identifier, reason }。ROLL_REQUEST を振らなかった。
 *   identifier は頼まれた結果の発言の識別子
 *
 * サーバーからだけ届くもの（AUTHORITATIVE・WITHDRAW・ROLE_REJECTED・ROLL_REJECTED）をクライアントが送っても、
 * サーバーはだれにも届けない
 */
export const AuthorityEvent = {
  AUTHORITATIVE: 'AUTHORITATIVE_OBJECT',
  WITHDRAW: 'WITHDRAW_GAME_OBJECT',
  ROLE_REQUEST: 'ROLE_REQUEST',
  ROLE_REJECTED: 'ROLE_REJECTED',
  ROLL_REQUEST: 'ROLL_REQUEST',
  ROLL_REJECTED: 'ROLL_REJECTED',
} as const;

/** サーバーだけが送るイベント。クライアントから来たものは届けない */
export const AUTHORITY_ONLY_EVENTS: readonly string[] = [
  AuthorityEvent.AUTHORITATIVE,
  AuthorityEvent.WITHDRAW,
  AuthorityEvent.ROLE_REJECTED,
  AuthorityEvent.ROLL_REJECTED,
];

/**
 * ダイスを振ってもらう。Axe は、自分で振るときと同じ形で結果の発言（alias 'chat'）を用意して送る。
 * サーバーは振った結果で syncData.value（文面）と、attributes の dicebot・tag・name を埋め、
 * attributes の from を `System-BCDice`、originFrom を頼んだ人の userId に、serverRoll を true にして、
 * 新しい発言として配る。
 * 頼んだ人の手元には、まだ置かないこと（サーバーから届く）
 */
export interface RollRequest {
  message: ObjectContext;
  /** 振るコマンド。全角を半角に直したもの。先頭に回数（`3 2d6`）を付けてもよい */
  command: string;
  /** ゲームシステムの ID。知らないものなら DiceBot で振る */
  gameSystem: string;
  /** 発言した人の名前。結果の名前は `<BCDice：名前>`（シークレットなら `<Secret-BCDice：名前>`） */
  speaker: string;
  /**
   * 結果の文面の後ろに付ける、対象のキャラの名前。` [名前]` の形で、名前は改行を含まず
   * MAX_ROLL_TARGET_NAME_LENGTH 文字まで。違う形なら、サーバーは振らない（ROLL_REJECTED の invalid）
   */
  suffix?: string;
}

/** ROLL_REQUEST の command の最長（文字数）。これより長い行は、Axe が手元で振る */
export const MAX_ROLL_COMMAND_LENGTH = 4000;

/** RollRequest の suffix に入れる名前の最長（文字数） */
export const MAX_ROLL_TARGET_NAME_LENGTH = 128;

/** 1つの接続が10秒のあいだに頼めるダイスの数。超えたものは rate-limited で断る */
export const MAX_ROLLS_PER_WINDOW = 20;

/**
 * ROLL_REQUEST を振らなかった理由。
 *
 * - invalid：頼み方の形が違う（結果の発言の形、suffix の形、大きすぎるもの）
 * - not-allowed：見学者が、見学者の話せないタブで振ろうとした
 * - rate-limited：短いあいだに頼みすぎた（MAX_ROLLS_PER_WINDOW）
 * - busy：部屋で振るのを待っているダイスが多すぎる
 * - not-a-command：BCDice のコマンドとして振れなかった（Axe が手元で振っても何も出ないもの）
 * - failed：振るあいだにサーバーで失敗した
 */
export type RollRejectReason =
  'invalid' | 'not-allowed' | 'rate-limited' | 'busy' | 'not-a-command' | 'failed';

/** サーバーが振った結果の発言の from */
export const DICE_BOT_SENDER = 'System-BCDice';

/**
 * サーバーが振った結果の発言にだけ true が入る attributes の項目。クライアントが送ってきた発言からは消す。
 * Axe はこれを見て、サーバーで振った結果だとわかるように見せられる
 */
export const SERVER_ROLL_FIELD = 'serverRoll';

/**
 * ROLE_REQUEST を断った理由。
 *
 * - not-game-master：頼んだ人が GM でない
 * - unknown-peer：その peerId の人が部屋にいない
 * - not-logged-in：ログインしていない人は見学のまま
 * - last-game-master：部屋の GM がいなくなる
 */
export type RoleRejectReason =
  'not-game-master' | 'unknown-peer' | 'not-logged-in' | 'last-game-master';

/**
 * 見てはいけない人に届けないもの、伏せて届けるもの。期待値は fixtures/visibility.json にある。
 *
 * - カード：表が見えない人（裏向きで、自分が覗いておらず、自分の手札でもない人。GM は見える）には、
 *   カードの下のデータ要素のうち image/front・common/name・common/text と detail の下を届けない
 * - メモ（disclosureMode が gm か selected で、見えない人）：common/title と common/text は文字を █ にして
 *   届け（空白はそのまま）、detail の下は届けない
 * - 持ち主のいるダイス：持ち主と GM のほかには、attributes.face を空にして届ける
 * - 秘話（attributes.to が空でない発言）：宛先と送り主（from か originFrom）だけに届ける。GM にも届けない
 * - シークレット（attributes.tag に secret がある発言）：送り主と GM のほかには、value と、attributes の
 *   MASKED_CHAT_ATTRIBUTES を空にして届ける
 * - タブ：plCanView・guestCanView で見てよくない役割には、そのタブの発言を届けない（SystemTab は誰にでも）
 * - リアクション（chat-reaction）：その発言が届かない人には届けない
 *
 * 見え方が変わったら、見えるようになった人には AUTHORITATIVE_OBJECT、見えなくなった人には
 * WITHDRAW_GAME_OBJECT を送る。見えないものに書こうとすると WITHDRAW_GAME_OBJECT が返り、伏せた形で
 * 持っているものを書き戻すと、伏せたところは置いてある中身に戻る。見えないものは消せない。
 * 消したものの子孫は、見えない人が消したときもサーバーが一緒に消し、持っている人に DELETE を送る
 */
export const MASKED_CHAT_ATTRIBUTES = [
  'dicebot',
  'stamp',
  'attachmentImageIdentifiers',
  'editHistory',
  'vnEmote',
] as const;

/** チャットの発言と、発言を入れるタブの種類。見学者が話せるのは guestCanSpeak のタブだけ */
export const CHAT_MESSAGE_ALIAS = 'chat';
export const CHAT_TAB_ALIAS = 'chat-tab';

/**
 * 接続しているあいだだけ置くオブジェクトの種類。syncData.peerId の人が部屋にいるあいだだけ持ち、
 * その人が出たら消す（DELETE は配らない。クライアントが leave を受けて自分で片付ける）。tombstone も残さない
 */
export const PEER_CURSOR_ALIAS = 'PeerCursor';

/**
 * UPDATE_GAME_OBJECT の data。サーバーは、決まった項目のほかは syncData を読まずに、そのまま置いて返す。
 * ObjectNode（カード、チャットの発言、タブ、データ要素など）の SyncVar は syncData.attributes に、
 * それ以外（PeerCursor など）の SyncVar は syncData の直下に入る
 */
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
