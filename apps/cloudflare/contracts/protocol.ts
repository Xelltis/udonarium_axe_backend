/**
 * The protocol between a room in the server version (RoomDurableObject in apps/cloudflare) and
 * Udonarium Axe.
 *
 * The server side owns this file, and the client uses a copy of the same content. It is not published
 * to npm. The tests on both sides read the same JSON in fixtures/ and make sure their verdicts do not
 * differ.
 *
 * A WebSocket frame is binary, and holds one of the envelopes below (ClientMessage and ServerMessage)
 * in MessagePack. The whole frame may be gzipped (it is taken as gzip when it starts with 1f 8b).
 * A text frame is used only to check that the connection is alive (`ping` is answered with `pong`).
 */

/** Raised when an envelope changes shape. The server refuses a hello of another version with protocol-mismatch. */
export const PROTOCOL_VERSION = 3;

/**
 * The room server's own peer id. It has a shape that cannot clash with a client's id.
 * A client treats this peer as present alongside the other members, and trades catalogs with this
 * peer only.
 */
export const AUTHORITY_PEER_ID = '@authority';

/** The check that the connection is alive. Sent in a text frame, it gets PONG back without waking the server. */
export const PING = 'ping';
export const PONG = 'pong';

/** The longest room name (in characters). Kept the same as the client's input field. */
export const MAX_ROOM_NAME_LENGTH = 255;
/** The longest room password (in characters). */
export const MAX_PASSWORD_LENGTH = 64;
/** How many people can be in one room at once. */
export const MAX_MEMBERS = 32;

/** An event between clients. Except for the ones the server reads, its contents are passed on as they are. */
export interface EventContext {
  eventName: string;
  data: unknown;
  /** The sender's peer id. The server overwrites it with the peer id of the connection it came on. */
  sendFrom: string;
}

/**
 * The role in a room. The server decides it, and the server also overwrites the role on PeerCursor.
 *
 * - gm: whoever made the room, and whoever a GM made gm
 * - pl: whoever came in logged in (unless an invite link or a GM changed it)
 * - guest: whoever came in without logging in, as a guest. They can write only their own cursor and
 *   lines in the tabs that guests may also speak in
 */
export const PEER_ROLES = ['gm', 'pl', 'guest'] as const;
export type PeerRole = (typeof PEER_ROLES)[number];

/**
 * How the user id of someone logged in begins. The server makes it by putting a UUID after `acct_`.
 * A guest (a hello without a token) cannot claim a userId that begins with this (it is refused with
 * unauthorized). That is because visibility follows the user id, so claiming the user id of someone
 * else, which shows on their cursor, would let one see that person's hand and whispers.
 */
export const ACCOUNT_USER_ID_PREFIX = 'acct_';

/**
 * The shape of the peer id Axe joins a room with: the digest of the user id (6 characters), the room
 * id (3 characters), the digest of the room name (8 characters), `-`, and the digest of the password
 * (7 characters when there is a password).
 * A peer id of this shape is not accepted unless the leading digest is that of the user id it claims.
 */
export const ROOM_PEER_ID_PATTERN = /^(\w{6})\w{3}\w{8}-(?:\w{7})?$/;

/**
 * The limit on an object's majorVersion. An UPDATE with a version above this is not accepted.
 * A version goes up by 1 with each write, so one that is too big stays the same when 1 is added, and
 * nobody can change the object anymore.
 */
export const MAX_OBJECT_VERSION = 2 ** 50;

/**
 * How far one write may raise majorVersion. Something placed for the first time may go up to this
 * value. Axe adds 1 with each write, so even with writes that did not arrive, it does not reach this
 * step. Letting the version jump far would let someone raise it to the limit and make the object
 * impossible for anyone to change. minorVersion is greater than -1 and less than 1 (Axe gives it a
 * random number at least 0 and less than 1, and the server may give -0.5 to a masked form).
 */
export const MAX_VERSION_STEP = 2 ** 20;

/** The identifier of the parent that holds Axe's chat tabs together. Tabs are placed right under it. */
export const CHAT_TAB_LIST_IDENTIFIER = 'ChatTabList';

/** The length of the user id digest at the start of a peer id (the start of its SHA-256 put through toBase62). */
export const PEER_ID_USER_DIGEST_LENGTH = 6;

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Turns bytes into the same base62 that Axe uses for peer ids. It writes them as a number in base 62,
 * and turns each leading 0 byte into one `0` (the same as base-x).
 */
export const toBase62 = (bytes: Uint8Array): string => {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let digits = '';
  while (value > 0n) {
    digits = BASE62[Number(value % 62n)] + digits;
    value /= 62n;
  }
  return '0'.repeat(zeros) + digits;
};

/** Someone in the room. */
export interface Member {
  peerId: string;
  userId: string;
  role: PeerRole;
}

// ---- client to server ----

/** The first thing sent after connecting. Nothing before it is accepted. */
export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** A peer id of the current shape (made from the digests of the user, the room and the password). */
  peerId: string;
  userId: string;
  /** For joining a room that has a password. */
  password?: string;
  /**
   * The access token when logged in (the one from POST /v1/auth/token).
   * Without it, the sender comes in as a guest (the `guest` role). With it, userId must be the same as
   * the token's userId. Without it, userId must not begin with ACCOUNT_USER_ID_PREFIX.
   */
  accessToken?: string;
  /** The invite that came with an invite link. It sets the role of someone logged in on their first time in. */
  invite?: string;
  /**
   * How long ago the person last used the page (milliseconds), by the pointer, the keys, the wheel or
   * touch. Without it, just now. Axe sends it on every connection, so that a page left alone does not
   * count as used again each time it reconnects. A hello whose idleMs is IDLE_SECONDS or more is
   * refused with idle.
   */
  idleMs?: number;
}

/** Sends a batch of events. With `to`, it reaches only that peer; without it, everyone but the sender. */
export interface SendMessage {
  type: 'send';
  to?: string;
  events: EventContext[];
}

/** Asks the server for its time. Used to measure how far the clocks are apart. */
export interface TimeRequest {
  type: 'time';
}

/** Asks for an invite to be made. Only a GM can make one. */
export interface InviteRequest {
  type: 'invite';
  role: PeerRole;
}

/**
 * Hands over a new access token while staying connected. A seat that came in logged in is closed with
 * unauthorized unless a new one arrives within a minute after its access token runs out. Axe sends
 * this when it changes its token.
 */
export interface AuthMessage {
  type: 'auth';
  accessToken: string;
}

/** Asks to be handed the room's asset token again, before it runs out. The answer comes as asset-token. */
export interface AssetTokenRequest {
  type: 'asset-token';
}

/**
 * Tells the server that the person used the page. Nothing comes back. Axe sends it when the page has
 * been used since it last sent one, at most once every ACTIVE_REPORT_SECONDS. A seat that sends none
 * for IDLE_SECONDS is closed with idle, so that a page left open does not keep the room and its
 * connection going.
 */
export interface ActiveMessage {
  type: 'active';
}

export type ClientMessage =
  HelloMessage | SendMessage | TimeRequest | InviteRequest | AuthMessage | AssetTokenRequest | ActiveMessage;

// ---- server to client ----

/** The answer to a hello that is let in. The server's catalog comes right after it. */
export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
  /** The peer id that was accepted. */
  peerId: string;
  /** The server's own peer id. Use this value rather than guessing it from the shape of peer ids. */
  authorityPeerId: string;
  /** This client's role, as the server decided it. Its own PeerCursor's role is set to this. */
  role: PeerRole;
  /** Who is in the room now. Neither the one who connected nor the server is included. */
  members: Member[];
  /** The server's time (Unix milliseconds). */
  serverTime: number;
  /**
   * The token for reading and writing this room's assets (/v1/rooms/:roomKey/assets/:sha256).
   * It goes in Authorization: Bearer. Any role may read, and only a GM or a player may put assets.
   */
  assetToken: string;
  /** When assetToken stops working (Unix milliseconds). Ask for it again with asset-token before then. */
  assetTokenExpiresAt: number;
  /**
   * How assets are put. Without it, an asset can be put with a single PUT up to the limit for its kind
   * (2MiB for pictures and 10MiB for sounds, the same sizes Axe can load).
   * Optional fields may still be added later. A client ignores fields it does not know.
   */
  assetUpload?: AssetUploadPolicy;
}

/**
 * How assets are put on the room server. A room server with a limit on the body of a single request
 * (the Vercel version) tells it in welcome.
 */
export interface AssetUploadPolicy {
  /** The limit on the bytes a single PUT takes. Anything bigger cannot be put with a PUT. */
  maxPutBytes: number;
  /**
   * Whether something bigger than maxPutBytes can be uploaded straight to the store. If it can, get
   * where to upload it from POST …/uploads, upload it, and report it with POST …/uploads/complete. If
   * it cannot, anything bigger cannot be put.
   */
  directUpload: boolean;
}

/** Someone came into the room. */
export interface JoinMessage {
  type: 'join';
  member: Member;
}

/** Someone left the room (their connection was lost). */
export interface LeaveMessage {
  type: 'leave';
  peerId: string;
}

/**
 * A batch of events. `from` is the sender's peer id, and AUTHORITY_PEER_ID when it is the server
 * itself.
 * The server may also slip its own events into someone else's batch (such as putting in and taking
 * out things whose visibility changed).
 * Tell who an event is from by each event's sendFrom, not by the batch's `from`.
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
 * An invite. `invite` goes in the invite link. When someone who is not a GM asked, invite and
 * expiresAt are null.
 * An invite decides the role of someone logged in who has not been in this room yet (someone who has
 * keeps their current role).
 */
export interface InviteMessage {
  type: 'invite';
  role: PeerRole;
  invite: string | null;
  /** When the invite stops working (Unix milliseconds). */
  expiresAt: number | null;
}

/**
 * A new asset token for the room. It comes after asking with asset-token, and when the role changes.
 * It takes the place of the current token.
 */
export interface AssetTokenMessage {
  type: 'asset-token';
  assetToken: string;
  /** Unix milliseconds. */
  expiresAt: number;
  /**
   * The role now. A token that comes when the role changes is for the new role, so Axe learns its own
   * role again from this (for example, when it becomes a GM or a player, it uploads the pictures and
   * sounds it has to the room).
   */
  role: PeerRole;
}

/**
 * Why a connection is closed. The server sends this, then closes with the same code as the reason.
 * When each one happens is in fixtures/errors.json.
 *
 * - protocol-mismatch: the hello's version differs from the server's
 * - room-not-found: there is no room (it has not been made, or it was deleted after its retention
 *   period)
 * - room-full: the room has reached MAX_MEMBERS people
 * - wrong-password: the password is wrong
 * - hello-required: the first message is not a hello
 * - bad-message: a message that cannot be read was sent
 * - too-many-messages: too much was sent in a short time
 * - replaced: someone made a new connection with the same peer id, so this one is closed. Do not
 *   reconnect
 * - unauthorized: the access token is invalid or expired, or userId differs from the token's. Refresh
 *   the token and reconnect.
 *   Also when, after connecting, no new token (auth) arrives within a minute after the token runs out.
 *   Also when someone claims the user id of someone logged in (one that begins with
 *   ACCOUNT_USER_ID_PREFIX) without a token
 * - banned: the operator of the room server banned the sender or the account, at the hello or
 *   while in the room. Do not reconnect
 * - room-deleted: the room's GM, or the operator of the room server, deleted the room. The room is
 *   gone, so do not reconnect
 * - idle: no active came for IDLE_SECONDS (the page was left alone), or the hello's idleMs was that
 *   long. Do not reconnect on your own; reconnect once the person asks to
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
  'banned',
  'room-deleted',
  'idle',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  /** The server's version. On protocol-mismatch, it tells which version to match. */
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

/** The WebSocket close code the server closes with. */
export const CLOSE_CODE = 4000;

/**
 * The close code for asking a client to reconnect on another connection (Service Restart). No error
 * is sent. The reason is rotate, for closing every few minutes on a platform that cannot hold a
 * connection for long, or moved, when the instance in charge of the room has changed.
 * The client reconnects at once, without showing the others that it left and came back.
 */
export const COME_BACK_CODE = 1012;
export const COME_BACK_REASONS = ['rotate', 'moved'] as const;

// ---- HTTP ----

/** The body of POST /v1/rooms. */
export interface CreateRoomRequest {
  name: string;
  password?: string;
}

/** The answer to POST /v1/rooms (201). */
export interface CreateRoomResponse {
  /** The room's key. Used to join with GET /v1/rooms/:roomKey/ws, and in invite links. */
  roomKey: string;
  /** The 3-character id that is shown. */
  roomId: string;
}

/** One row of GET /v1/rooms. */
export interface RoomSummary {
  roomKey: string;
  roomId: string;
  name: string;
  hasPassword: boolean;
  /** How many people are in it now. */
  members: number;
  /**
   * True when whoever got the list with an access token is a GM of this room (missing otherwise).
   * A room that can be deleted with DELETE /v1/rooms/:roomKey.
   */
  deletable?: boolean;
}

export interface RoomListResponse {
  rooms: RoomSummary[];
}

/** The answer to GET /v1/rooms/:roomKey. An old room that is not on the list can also be looked up by its key. */
export interface RoomResponse {
  room: RoomSummary;
}

/**
 * A header that may be sent with PUT /v1/rooms/:roomKey/assets/:sha256. It holds the asset's name (the
 * file name) run through encodeURIComponent. Besides coming back in the list from
 * GET /v1/rooms/:roomKey/assets, it also comes with the answers to HEAD and GET in the same header (a
 * page can read it, through Access-Control-Expose-Headers).
 */
export const ASSET_NAME_HEADER = 'X-Asset-Name';
/** The longest asset name (in characters). A longer one is cut short. */
export const MAX_ASSET_NAME_LENGTH = 255;

/** One asset stored in the room. */
export interface RoomAsset {
  /** The SHA-256 of its contents (lowercase hex). */
  id: string;
  /** The type of its contents (image/png, audio/ogg and so on). */
  type: string;
  size: number;
  /** The name given by whoever put it. Empty when there is none. */
  name: string;
}

/**
 * The answer to GET /v1/rooms/:roomKey/assets: every asset stored in that room. Asked with the room's
 * asset token.
 * Used on joining a room, to fetch pictures and sounds that are in no one's catalog but are still in
 * the room.
 */
export interface RoomAssetListResponse {
  assets: RoomAsset[];
}

/** What a report to the room server's operator is about: a picture or sound in the room, or the room. */
export const REPORT_TARGETS = ['asset', 'room'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

/** The longest reason a report may give, in characters. */
export const MAX_REPORT_REASON_LENGTH = 500;

/**
 * The body of POST /v1/rooms/:roomKey/reports: a seat of the room (any role) tells the room server's
 * operator of something in it, with the room's asset token. The server keeps who reported along
 * with it, so that false reports can be told apart. 201 with ReportResponse; 400 invalid-request for
 * a body in the wrong form.
 */
export interface ReportRequest {
  target: ReportTarget;
  /** The SHA-256 of the picture or sound (lowercase hex), for target asset. */
  assetId?: string;
  /** Why, in the reporter's words: 1 to MAX_REPORT_REASON_LENGTH characters. */
  reason: string;
}

export interface ReportResponse {
  /** The report's id, to quote when asking about it. */
  id: string;
}

/**
 * The answer to PUT /v1/rooms/:roomKey/assets/:sha256 and POST …/uploads/complete. 201 when it was
 * stored, and 200 when it was already there.
 */
export interface AssetStoredResponse {
  id: string;
  status: 'stored' | 'exists';
}

/**
 * The body of POST /v1/rooms/:roomKey/assets/:sha256/uploads. On a room server whose welcome has an
 * assetUpload with directUpload, it asks where to upload something bigger than maxPutBytes. It is
 * asked with the room's asset token. When the asset is already stored, AssetStoredResponse (200,
 * exists) comes back instead of where to upload.
 */
export interface UploadTicketRequest {
  /** The size in bytes of the contents to upload. */
  size: number;
  /** The asset's name (the file name). A longer one is cut at MAX_ASSET_NAME_LENGTH characters. */
  name?: string;
}

/**
 * Where to upload straight to the store. Send only the contents to this URL, with this method and
 * these headers. Do not add the room's asset token (Authorization). The store checks the size, the
 * expiry and that nothing is overwritten.
 */
export interface DirectUploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  /** Uploading no longer works after this time (Unix milliseconds). */
  expiresAt: number;
}

/** The answer to POST …/uploads (201). Upload to `upload`, then send `ticket` to POST …/uploads/complete. */
export interface UploadTicketResponse {
  ticket: string;
  upload: DirectUploadTarget;
}

/**
 * The body of POST /v1/rooms/:roomKey/assets/:sha256/uploads/complete. When told the upload is done,
 * the room server checks the contents and makes them an asset of the room. The answer is
 * AssetStoredResponse.
 */
export interface UploadCompleteRequest {
  ticket: string;
}

/** GET /v1/auth/config: the login providers. When empty, neither login nor rooms can be used on this server. */
export interface AuthConfigResponse {
  providers: 'discord'[];
}

/**
 * The body of POST /v1/auth/token.
 *
 * - login_code: hands over the code that came in the URL fragment (#login_code=…) on coming back
 *   from logging in, and the code_verifier that the code_challenge was made from when the login began
 * - refresh_token: before the access token runs out, trades the refresh token for a new pair.
 *   A refresh token that has been used stops working. Using the same one again makes every token in
 *   that family invalid
 */
export type TokenRequest =
  | { grant_type: 'login_code'; code: string; code_verifier: string }
  | { grant_type: 'refresh_token'; refresh_token: string };

/** Someone logged in. */
export interface Account {
  /** The user id that never changes (it begins with ACCOUNT_USER_ID_PREFIX). Use it as the hello's userId. */
  userId: string;
  name: string;
  /** The URL of the avatar picture. Null when there is none. */
  avatarUrl: string | null;
}

/** The answer to POST /v1/auth/token. */
export interface TokenResponse {
  /** Used in the WebSocket hello and in Authorization: Bearer. */
  accessToken: string;
  /** How many seconds the access token works for. */
  expiresIn: number;
  refreshToken: string;
  account: Account;
}

// ---- sync ----

/**
 * The events whose contents the server reads. Other events are passed on without reading their
 * contents.
 *
 * - UPDATE and DELETE are applied to the state the server holds, whoever they are addressed to, and
 *   then sent to everyone but the sender
 * - CATALOG, REQUEST and REQUEST_CATALOG are answered by the server when they are addressed to the
 *   server (or to no one)
 * - FORGET_DELETED also clears the server's tombstones, and is then sent to everyone
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
 * Events used only between a client and the server.
 *
 * - AUTHORITATIVE (from the server): data is an ObjectContext. Replace the object whatever its
 *   version, and also remove its deleted mark. Used to have a client undo a change made without
 *   permission to write it, and to hand the sender something whose contents the server fixed
 * - WITHDRAW (from the server): data is { identifier }. Take the object out locally without leaving a
 *   deleted mark. Used to have clients withdraw something made by someone without permission to
 *   write it
 * - ROLE_REQUEST (to the server): data is { peerId, role }. A GM changes the role of someone in the
 *   room
 * - ROLE_REJECTED (from the server): data is { peerId, role, reason }. The ROLE_REQUEST was refused
 * - ROLL_REQUEST (to the server): data is a RollRequest. The server rolls with BCDice and sends the
 *   result line to everyone
 * - ROLL_REJECTED (from the server): data is { identifier, reason }. The ROLL_REQUEST was not rolled.
 *   identifier is the identifier of the result line that was asked for
 *
 * When a client sends one of those that only come from the server (AUTHORITATIVE, WITHDRAW,
 * ROLE_REJECTED and ROLL_REJECTED), the server passes it on to nobody.
 */
export const AuthorityEvent = {
  AUTHORITATIVE: 'AUTHORITATIVE_OBJECT',
  WITHDRAW: 'WITHDRAW_GAME_OBJECT',
  ROLE_REQUEST: 'ROLE_REQUEST',
  ROLE_REJECTED: 'ROLE_REJECTED',
  ROLL_REQUEST: 'ROLL_REQUEST',
  ROLL_REJECTED: 'ROLL_REJECTED',
} as const;

/** The events only the server sends. Those that come from a client are not passed on. */
export const AUTHORITY_ONLY_EVENTS: readonly string[] = [
  AuthorityEvent.AUTHORITATIVE,
  AuthorityEvent.WITHDRAW,
  AuthorityEvent.ROLE_REJECTED,
  AuthorityEvent.ROLL_REJECTED,
];

/**
 * Asks the server to roll dice. Axe prepares the result line (alias 'chat') in the same form as when
 * it rolls by itself, and sends it.
 * With the result of the roll, the server fills in syncData.value (the text) and dicebot, tag and
 * name in attributes, sets `from` in attributes to `System-BCDice`, originFrom to the userId of
 * whoever asked, and serverRoll to true, and sends it out as a new line.
 * Do not place it on the asker's side yet (it comes from the server).
 *
 * The line goes in a tab right under the tab list (CHAT_TAB_LIST_IDENTIFIER). Otherwise it is not
 * rolled (invalid).
 * The version goes up to MAX_VERSION_STEP. When the timestamp in attributes is 10 minutes or more
 * before the server's time, it is moved up to 10 minutes before (a later time is not moved). For the
 * place in the order, majorIndex is set to 0, and minorIndex to at least 0 and less than 1.
 * stamp, attachmentImageIdentifiers, replyTo, quoteOf and fixd are set back to their defaults, and
 * editHistory, disclosedAt, pseudoDeletedAt and afterWhisper* are removed.
 */
export interface RollRequest {
  message: ObjectContext;
  /** The command to roll, with full-width characters made half-width. It may start with a repeat count (`3 2d6`). */
  command: string;
  /** The game system's id. An unknown one is rolled with DiceBot. */
  gameSystem: string;
  /**
   * The name of whoever spoke. The result's name is `<BCDice：name>` (`<Secret-BCDice：name>` for a
   * secret roll), with a full-width colon.
   */
  speaker: string;
  /**
   * The name of the targeted character, put after the text of the result. It has the form ` [name]`,
   * where the name has no line break, square bracket or `→`, and is at most
   * MAX_ROLL_TARGET_NAME_LENGTH characters. When the form is different, the server does not roll
   * (invalid in ROLL_REJECTED).
   */
  suffix?: string;
}

/** The longest command in a ROLL_REQUEST (in characters). Axe rolls a longer line by itself. */
export const MAX_ROLL_COMMAND_LENGTH = 4000;

/** The longest name that goes in the suffix of a RollRequest (in characters). */
export const MAX_ROLL_TARGET_NAME_LENGTH = 128;

/**
 * The length (in seconds) of the window in which what one connection sends and the dice it asks for
 * are counted. Counting runs for this long from the first thing that arrives after a window ends.
 */
export const RATE_WINDOW_SECONDS = 10;

/** How many rolls one connection may ask for in RATE_WINDOW_SECONDS. Any more are refused with rate-limited. */
export const MAX_ROLLS_PER_WINDOW = 20;

/**
 * How long a seat may go without telling active (in seconds). Past it, the seat is closed with idle.
 * It is long enough for someone who only watches and listens through a long scene.
 */
export const IDLE_SECONDS = 3 * 60 * 60;

/** How often, at most, Axe sends active while the page is being used (in seconds). */
export const ACTIVE_REPORT_SECONDS = 5 * 60;

/**
 * Why a ROLL_REQUEST was not rolled.
 *
 * - invalid: the request has the wrong form (the form of the result line, the tab it goes in, the
 *   version, the form of suffix, or something too big)
 * - not-allowed: a guest tried to roll in a tab where guests cannot speak
 * - rate-limited: too many were asked for in a short time (MAX_ROLLS_PER_WINDOW)
 * - busy: too many dice are waiting to be rolled in the room
 * - not-a-command: it could not be rolled as a BCDice command (one that shows nothing even when Axe
 *   rolls it by itself)
 * - failed: something failed on the server while rolling
 */
export const ROLL_REJECT_REASONS = [
  'invalid',
  'not-allowed',
  'rate-limited',
  'busy',
  'not-a-command',
  'failed',
] as const;
export type RollRejectReason = (typeof ROLL_REJECT_REASONS)[number];

/** The sender (from) of a result line that the server rolled. */
export const DICE_BOT_SENDER = 'System-BCDice';

/**
 * The field in attributes that is true only on a result line the server rolled. It is removed from
 * lines a client sends. From it, Axe can show that a result was rolled on the server.
 */
export const SERVER_ROLL_FIELD = 'serverRoll';

/**
 * Why a ROLE_REQUEST was refused.
 *
 * - not-game-master: whoever asked is not a GM
 * - unknown-peer: nobody with that peerId is in the room
 * - not-logged-in: someone not logged in stays a guest
 * - last-game-master: the room would be left with no GM
 */
export const ROLE_REJECT_REASONS = ['not-game-master', 'unknown-peer', 'not-logged-in', 'last-game-master'] as const;
export type RoleRejectReason = (typeof ROLE_REJECT_REASONS)[number];

/**
 * What is not sent to those who must not see it, and what is sent masked. The expected results are in
 * fixtures/visibility.json.
 *
 * - Cards: to those who cannot see the face (when it is face down, they have not peeked at it, and it
 *   is not in their own hand; a GM can see it), image/front, common/name and common/text among the
 *   data elements under the card, and everything under detail, are not sent
 * - Notes (to those who cannot see them, when disclosureMode is gm or selected): common/title and
 *   common/text are sent with their characters turned into █ (spaces stay as they are), and
 *   everything under detail is not sent
 * - Dice with an owner: to anyone but the owner and GMs, attributes.face is sent empty, and
 *   common/name (the name) among the data elements under the dice is not sent
 * - Whispers (lines whose attributes.to is not empty): sent only to the addressees and the sender
 *   (from or originFrom). Not sent to GMs either
 * - Secret lines (lines with secret in attributes.tag): to anyone but the sender and GMs, value and
 *   MASKED_CHAT_ATTRIBUTES in attributes are sent empty
 * - Tabs: the lines in a tab are not sent to roles that plCanView and guestCanView do not let see it
 *   (SystemTab goes to everyone)
 * - Reactions (chat-reaction): not sent to anyone the line does not reach
 *
 * When visibility changes, AUTHORITATIVE_OBJECT is sent to those who can now see a thing, and
 * WITHDRAW_GAME_OBJECT to those who no longer can. Trying to write to something that cannot be seen
 * gets WITHDRAW_GAME_OBJECT back, and writing back something held in masked form returns the masked
 * parts to the stored contents. Something that cannot be seen cannot be deleted.
 * The descendants of something deleted are deleted along with it by the server, even when someone who
 * cannot see them deleted it, and DELETE is sent to those who hold them.
 */
export const MASKED_CHAT_ATTRIBUTES = [
  'dicebot',
  'stamp',
  'attachmentImageIdentifiers',
  'editHistory',
  'vnEmote',
] as const;

/** The kinds of a chat line and of the tab that lines go in. Guests can speak only in tabs with guestCanSpeak. */
export const CHAT_MESSAGE_ALIAS = 'chat';
export const CHAT_TAB_ALIAS = 'chat-tab';

/**
 * The kind of object kept only while connected. It is held only while the person with its
 * syncData.peerId is in the room, and removed when that person leaves (DELETE is not sent out; clients
 * clean up by themselves on leave). No tombstone is left either.
 */
export const PEER_CURSOR_ALIAS = 'PeerCursor';

/**
 * The data of UPDATE_GAME_OBJECT. Apart from certain fields, the server does not read syncData, and
 * stores and returns it as it is.
 * The SyncVars of an ObjectNode (a card, a chat line, a tab, a data element and so on) go in
 * syncData.attributes, and those of anything else (PeerCursor and so on) go right under syncData.
 */
export interface ObjectContext {
  aliasName: string;
  identifier: string;
  majorVersion: number;
  minorVersion: number;
  syncData: Record<string, unknown>;
}

/** One item in the data of SYNCHRONIZE_GAME_OBJECT. Its version is majorVersion + minorVersion. */
export interface CatalogItem {
  identifier: string;
  version: number;
}

/** The most items that go in one SYNCHRONIZE_GAME_OBJECT. Kept the same as the client. */
export const CATALOG_BATCH = 2048;

/** A synced object's version, compared by majorVersion + minorVersion (minorVersion is at least 0 and less than 1). */
export interface ObjectVersion {
  majorVersion: number;
  minorVersion: number;
}

/**
 * What to do with an UPDATE_GAME_OBJECT that arrives.
 *
 * - accept: newer than the one held (or seen for the first time). Replace it, and send it to the
 *   others
 * - same: the same version as the one held. Do nothing
 * - stale: older than the one held. Send the one held back to the sender
 * - deleted: a deleted object. Send DELETE_GAME_OBJECT back to the sender
 */
export type UpdateVerdict = 'accept' | 'same' | 'stale' | 'deleted';

/**
 * The verdict that lets the last write win (LWW). As in the client's ObjectSynchronizer, it takes the
 * update only when the sum is strictly greater.
 */
export const judgeUpdate = (stored: ObjectVersion | null, incoming: ObjectVersion, deleted: boolean): UpdateVerdict => {
  if (deleted) return 'deleted';
  if (!stored) return 'accept';
  const storedVersion = stored.majorVersion + stored.minorVersion;
  const incomingVersion = incoming.majorVersion + incoming.minorVersion;
  if (incomingVersion > storedVersion) return 'accept';
  return incomingVersion === storedVersion ? 'same' : 'stale';
};
