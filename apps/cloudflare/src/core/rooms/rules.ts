import { createHash } from 'node:crypto';

import {
  AUTHORITY_PEER_ID,
  CHAT_TAB_ALIAS,
  DICE_BOT_SENDER,
  PEER_ID_USER_DIGEST_LENGTH,
  ROOM_PEER_ID_PATTERN,
  SERVER_ROLL_FIELD,
  toBase62,
} from '../../../contracts/protocol.js';
import type { EventContext, ObjectContext } from '../../../contracts/protocol.js';
import type { Seat } from './host.js';
import { MAX_VIEW_BYTES, ROLL_TIME_TOLERANCE_MS } from './limits.js';
import type { StoredEntry } from './object-index.js';
import { describe, seesDisclosed } from './visibility.js';
import type { View } from './visibility.js';

// 部屋のサーバーが、受けたものを確かめるときの決まり。どれも状態を持たない

/**
 * 時刻を、今から ROLL_TIME_TOLERANCE_MS より前へはずらさせない。数でなければ今。先へは寄せない。
 * Axe は次の発言をタブの最後の行より後ろに置くので、先の時刻の行があるタブでは、結果もその後ろに来る
 */
export const notLongAgo = (timestamp: unknown): number => {
  const now = Date.now();
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return now;
  return Math.max(timestamp, now - ROLL_TIME_TOLERANCE_MS);
};

/** 並びの位置の端数。Axe は 0 以上 1 未満を付ける。その外のものと数でないものは 0 */
export const indexFraction = (value: unknown): number =>
  typeof value === 'number' && value >= 0 && value < 1 ? value : 0;

export const memberOf = (seat: Seat) => ({
  peerId: seat.peerId,
  userId: seat.userId,
  role: seat.role,
});

/**
 * 同じ人の席か。ピア ID が同じでも、ユーザー ID とログインの有無まで同じでなければ別人とみなす。
 * ログインした人のユーザー ID はトークンで確かめてあるので、ほかの人には名乗れない
 */
export const isSamePerson = (a: Seat, b: Seat): boolean => a.userId === b.userId && a.account === b.account;

/**
 * そのユーザー ID で、そのピア ID を名乗ってよいか。Axe の部屋のピア ID は、頭にユーザー ID の
 * ダイジェストを持つので、合わないものはほかの人のピア ID。形の違うものは、だれの Axe のピア ID とも
 * 重ならないので受ける
 */
export const mayClaimPeerId = (userId: string, peerId: string): boolean => {
  const shaped = ROOM_PEER_ID_PATTERN.exec(peerId);
  if (!shaped) return true;
  // 確かめるあいだにほかのメッセージが割り込まないよう、同期で計算する
  const digest = toBase62(new Uint8Array(createHash('sha256').update(userId).digest()));
  return shaped[1] === digest.slice(0, PEER_ID_USER_DIGEST_LENGTH);
};

export const isHello = (value: unknown): value is { protocolVersion?: unknown } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'hello';

export const fromAuthority = (eventName: string, data: unknown): EventContext => ({
  eventName,
  data,
  sendFrom: AUTHORITY_PEER_ID,
});

/** シークレットの tag から secret の語を外したものか。Axe の公開（discloseMessage）が書き換える形 */
export const isDisclosureOf = (secretTag: unknown, tag: unknown): boolean => {
  const words = String(secretTag).trim().split(/\s+/);
  return words.includes('secret') && tag === words.filter((word) => word !== 'secret').join(' ');
};

/** 見え方の手がかりが、索引と SQLite の1行に置ける大きさか */
export const fitsIndex = (context: ObjectContext): boolean => {
  const { parent, view } = describe(context);
  return parent.length <= 256 && JSON.stringify(view).length <= MAX_VIEW_BYTES;
};

/**
 * GM でない人が、見え方を決めるところをそう変えてよいか。Axe の画面が許すことだけを許す。
 *
 * - メモの公開の範囲は、持ち主だけが変えられる。持ち主は、持ち主か、持ち主のいないものを自分にする人が変えられる。
 *   持ち主のいないメモを自分のものにできるのは、いまそのメモが見える人だけ（GM だけのメモは取れない）
 * - ダイスの持ち主も同じ
 * - カードの持ち主（覗いている人）は、自分にするか、空にするだけ。ほかの人の手札のカードは、向きも
 *   持ち主も変えられない
 * - ほかの人の手札のカードは、伏せたまま自分の手札へ引くことだけができる
 * - タブを PL や見学者に見せるかは、GM だけが変えられる
 * - 発言の宛先と、シークレットを外すことは、送り主だけ（ダイスの結果は振った人）。送り主はだれも変えられない
 */
export const mayChangeView = (before: View | null, after: View | null, seat: Seat): boolean => {
  if (!before || !after || before.kind !== after.kind) return true;
  const ownerMove = (from: string, to: string) =>
    from === to || from === seat.userId || (from === '' && to === seat.userId);
  switch (before.kind) {
    case 'note': {
      const next = after as typeof before;
      const disclosureSame = before.mode === next.mode && JSON.stringify(before.users) === JSON.stringify(next.users);
      const claimsUnseen = before.owner === '' && next.owner === seat.userId && !seesDisclosed(before, seat);
      return (disclosureSame || before.owner === seat.userId) && ownerMove(before.owner, next.owner) && !claimsUnseen;
    }
    case 'die':
      return ownerMove(before.owner, (after as typeof before).owner);
    case 'card': {
      const next = after as typeof before;
      if (before.hand !== '' && before.hand !== seat.userId) {
        // 引くことだけは通す。自分の手札へ、伏せて、だれも覗いていない形で移す（Axe の「相手の手札から引く」）
        const drawn = next.hand === seat.userId && !next.front && next.owner === '';
        return drawn || JSON.stringify(next) === JSON.stringify(before);
      }
      return next.owner === before.owner || next.owner === '' || next.owner === seat.userId;
    }
    case 'tab': {
      const next = after as typeof before;
      return next.pl === before.pl && next.guest === before.guest;
    }
    case 'chat': {
      const next = after as typeof before;
      if (next.from !== before.from || next.originFrom !== before.originFrom) return false;
      const sender = before.from === seat.userId || before.originFrom === seat.userId;
      const toSame = JSON.stringify(before.to) === JSON.stringify(next.to);
      return (toSame && (next.secret || !before.secret)) || sender;
    }
    default:
      return true;
  }
};

/**
 * タブを別の親の下へ移す書き込みか。Axe はタブを動かさないので、GM のほかには許さない。許すと、見えない
 * ところに作ったタブで振り、よい目のときだけタブごと見えるところへ出せてしまう
 */
export const movesTab = (existing: StoredEntry, context: ObjectContext): boolean =>
  existing.alias === CHAT_TAB_ALIAS && describe(context).parent !== existing.parent;

/** 人の名乗れないユーザー ID。Axe が発言の送り主に使う名前 */
export const RESERVED_USER_IDS: ReadonlySet<string> = new Set([DICE_BOT_SENDER, 'System']);

/**
 * サーバーが振った結果の発言で、書き換えさせない attributes（ほかに syncData の value と親のタブと並びの
 * 位置 ROLLED_PLACE も）。宛先と時刻と並びの位置も守る。守らないと、自分だけに宛てて何度も振り、よい目だけを
 * 全員に宛て直したり、行を好きな位置へ動かしたりできてしまう。並びの位置（disclosedAt と ROLLED_PLACE）は、
 * シークレットを公開したときだけ変わってよい
 */
export const ROLLED_ATTRIBUTES = [
  'disclosedAt',
  'dicebot',
  'tag',
  'name',
  'from',
  'originFrom',
  SERVER_ROLL_FIELD,
  'to',
  'timestamp',
  'editHistory',
  'fixd',
  'stamp',
  'attachmentImageIdentifiers',
  'replyTo',
  'quoteOf',
  'afterWhisperAt',
  'afterWhisperTo',
  'afterWhisperName',
];

/**
 * 振った結果に、頼んだ人が付けてきても持ち込ませない attributes と、その代わりに置く値（undefined は外す）。
 * 本文のほかに見えるもの（スタンプ・添付の画像・返信や引用）、手を加えた印、並びの位置と、後からだけ
 * 付く印。Axe が結果に付けるのは、どれも既定の値だけ
 */
export const ROLL_NEUTRAL_ATTRIBUTES: Readonly<Record<string, unknown>> = {
  stamp: '',
  attachmentImageIdentifiers: '',
  replyTo: '',
  quoteOf: '',
  fixd: false,
  editHistory: undefined,
  disclosedAt: undefined,
  pseudoDeletedAt: undefined,
  afterWhisperAt: undefined,
  afterWhisperTo: undefined,
  afterWhisperName: undefined,
};

/** 頼まれた結果の attributes から、持ち込ませないものを既定の値にする。もとから無いものは足さない */
export const neutralRollAttributes = (attributes: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attributes).flatMap(([field, value]): [string, unknown][] => {
      // 継承した名前（constructor など）は、持ち込ませない項目に数えない
      if (!Object.hasOwn(ROLL_NEUTRAL_ATTRIBUTES, field)) return [[field, value]];
      const neutral = ROLL_NEUTRAL_ATTRIBUTES[field];
      return neutral === undefined ? [] : [[field, neutral]];
    })
  );

/** 発言の並びの位置。ObjectNode そのものの SyncVar なので、attributes ではなく syncData の直下にある */
export const ROLLED_PLACE = ['majorIndex', 'minorIndex'];

/** サーバーが振った結果の発言で、GM のほかには書き換えさせない attributes（消したことにする印） */
export const ROLLED_GM_ATTRIBUTES = ['pseudoDeletedAt'];
