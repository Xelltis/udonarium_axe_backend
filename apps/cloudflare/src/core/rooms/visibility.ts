import { MASKED_CHAT_ATTRIBUTES } from '../../../contracts/protocol.js';
import type { ObjectContext, PeerRole } from '../../../contracts/protocol.js';
import { attributesOf, withAttributes } from './objects.js';

// 見てはいけない情報を、見てはいけない人に届けないための決まり。Axe が手元で見せる・見せないを
// 決めている決まり（カードの向き、秘話、シークレットダイス、タブの閲覧、公開の範囲）を写したもの。
//
// オブジェクトごとに、見え方を決める小さな手がかり（View）を作っておき、見る人と、親をたどった道筋
// から、まるごと見せる（full）・一部を伏せて見せる（masked）・見せない（hidden）を決める。
// 親がまだ届いていないもの（pending）は、決まりをたどりきれないので、親が届くまでだれにも見せない。

/** 見る人 */
export interface Viewer {
  userId: string;
  role: PeerRole;
}

export type ViewKind = 'full' | 'masked' | 'pending' | 'hidden';

/** その見え方なら、その人に届けるか（まるごとか、伏せた形で） */
export const delivered = (kind: ViewKind): boolean => kind === 'full' || kind === 'masked';

/** 見え方を決める手がかり。オブジェクトの中身から作り、メモリと SQLite に置く */
export type View =
  /** カード。表が見えるのは、表向き・覗いている本人・手札の持ち主 */
  | { kind: 'card'; front: boolean; owner: string; hand: string }
  /** 公開の範囲を絞れるメモ（disclosureMode） */
  | { kind: 'note'; mode: string; users: string[]; owner: string }
  /** 持ち主のいるダイス。出目が見えるのは持ち主 */
  | { kind: 'die'; owner: string }
  /** チャットの発言。秘話は宛先と送り主だけ、シークレットは送り主だけが中身を読める */
  | { kind: 'chat'; to: string[]; from: string; originFrom: string; secret: boolean }
  /** チャットのタブ。PL と見学者が見てよいか */
  | { kind: 'tab'; pl: boolean; guest: boolean }
  /** データ要素（カードの表、メモの本文など）。名前で、どこにあるものかがわかる */
  | { kind: 'data'; name: string }
  /** 発言へのリアクション。その発言が見えない人には見せない */
  | { kind: 'reaction'; message: string };

/** 索引の1行のうち、見え方に要るところ */
export interface ViewEntry {
  parent: string;
  view: View | null;
}

/** 識別子から索引の1行を引く */
export type Lookup = (identifier: string) => ViewEntry | null;

/** いつもすべての役割から見えるタブ（Axe の SYSTEM_CHAT_TAB_IDENTIFIER） */
const SYSTEM_TAB = 'SystemTab';

const HAND_PREFIX = 'hand:';

/** 親をたどる深さの上限。親が輪になっているものでも止まる */
const MAX_DEPTH = 64;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** オブジェクトの中身から、親と見え方の手がかりを作る */
export const describe = (context: ObjectContext): ViewEntry => {
  const { syncData } = context;
  const attributes = attributesOf(context);
  const parent = text(syncData.parentIdentifier);
  switch (context.aliasName) {
    case 'card': {
      const location = text((attributes.location as { name?: unknown } | undefined)?.name);
      return {
        parent,
        view: {
          kind: 'card',
          front: attributes.state === 0,
          owner: text(attributes.owner),
          hand: location.startsWith(HAND_PREFIX) ? location.slice(HAND_PREFIX.length) : '',
        },
      };
    }
    case 'text-note':
      return {
        parent,
        view: {
          kind: 'note',
          mode: text(attributes.disclosureMode),
          users: Array.isArray(attributes.disclosureUserIds)
            ? attributes.disclosureUserIds.filter((id): id is string => typeof id === 'string')
            : [],
          owner: text(attributes.owner),
        },
      };
    case 'dice-symbol':
      return { parent, view: { kind: 'die', owner: text(attributes.owner) } };
    case 'chat':
      return {
        parent,
        view: {
          kind: 'chat',
          to: text(attributes.to).trim().split(/\s+/).filter(Boolean),
          from: text(attributes.from),
          originFrom: text(attributes.originFrom),
          secret: text(attributes.tag).split(/\s+/).includes('secret'),
        },
      };
    case 'chat-tab': {
      const always = context.identifier === SYSTEM_TAB;
      return {
        parent,
        view: {
          kind: 'tab',
          pl: always || Boolean(attributes.plCanView),
          guest: always || Boolean(attributes.guestCanView),
        },
      };
    }
    case 'data':
      return { parent, view: { kind: 'data', name: text(attributes.name) } };
    case 'chat-reaction':
      return { parent, view: { kind: 'reaction', message: text(syncData.messageIdentifier) } };
    default:
      return { parent, view: null };
  }
};

const isGameMaster = (viewer: Viewer) => viewer.role === 'gm';

/**
 * 発言を送ったのがその人か。ダイスの結果は、振った人（originFrom）が送ったものとして扱う。
 * 空の送り主は、だれの発言でもない（originFrom の無い発言と、空のユーザー ID を一致させない）
 */
const sentBy = (view: { from: string; originFrom: string }, viewer: Viewer) =>
  viewer.userId !== '' && (view.from === viewer.userId || view.originFrom === viewer.userId);

/** カードの表が見えるか。GM はいつも見える（Axe の GM 用の一覧は、裏向きのカードの表も出す） */
const seesFace = (view: { front: boolean; owner: string; hand: string }, viewer: Viewer) =>
  isGameMaster(viewer) ||
  view.front ||
  (view.owner !== '' && view.owner === viewer.userId) ||
  (view.hand !== '' && view.hand === viewer.userId);

/** 公開の範囲（Axe の canViewDisclosable）。GM と持ち主はいつも見える */
export const seesDisclosed = (
  view: { mode: string; users: string[]; owner: string },
  viewer: Viewer,
) => {
  if (isGameMaster(viewer)) return true;
  if (view.owner !== '' && view.owner === viewer.userId) return true;
  if (view.mode === 'gm') return false;
  if (view.mode === 'selected') return view.users.includes(viewer.userId);
  return true;
};

/** そのオブジェクト自身の見え方 */
const ownKind = (view: View | null, viewer: Viewer): ViewKind => {
  if (view?.kind === 'chat') {
    // 秘話は宛先と送り主だけ。GM にも見せない（Axe も GM に秘話を見せない）
    if (view.to.length > 0 && !view.to.includes(viewer.userId) && !sentBy(view, viewer)) {
      return 'hidden';
    }
    // シークレットは、送り主と GM のほかには中身を伏せる（行そのものは届き、「シークレットダイス」と出る）
    return view.secret && !sentBy(view, viewer) && !isGameMaster(viewer) ? 'masked' : 'full';
  }
  if (view?.kind === 'die') {
    return view.owner !== '' && view.owner !== viewer.userId && !isGameMaster(viewer)
      ? 'masked'
      : 'full';
  }
  return 'full';
};

/**
 * カードの下で、表が見えない人には見せないデータ要素。表の絵、名前、表の文字、詳細。
 * 裏の絵、大きさ、文字の大きさと色、入れ物は見せる（裏で描けるように）
 */
const hiddenUnderCard = (path: string[]) =>
  (path[0] === 'image' && path[1] === 'front') ||
  (path[0] === 'common' && (path[1] === 'name' || path[1] === 'text')) ||
  (path[0] === 'detail' && path.length > 1);

/**
 * 持ち主のいるダイスの下で、出目の見えない人には見せないデータ要素。名前（Axe はラベルごと描かない）
 */
const hiddenUnderDie = (path: string[]) => path[0] === 'common' && path[1] === 'name';

/**
 * 公開の範囲の外の人に、メモの下で伏せるもの。題と本文は文字を █ にして見せ（Axe が描くのと同じ形）、
 * 詳細は見せない
 */
const kindUnderNote = (path: string[]): ViewKind =>
  path[0] === 'common' && (path[1] === 'title' || path[1] === 'text')
    ? 'masked'
    : path[0] === 'detail' && path.length > 1
      ? 'hidden'
      : 'full';

/** 伏せる強さの順。後ろほど強い */
const STRICTNESS: readonly ViewKind[] = ['full', 'masked', 'pending', 'hidden'];

/** now の方が then より多く見せるか */
export const looser = (now: ViewKind, then: ViewKind): boolean =>
  STRICTNESS.indexOf(now) < STRICTNESS.indexOf(then);

/** 2つの見え方のうち、より伏せる方 */
const stricter = (a: ViewKind, b: ViewKind): ViewKind =>
  STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;

/**
 * その人に、そのオブジェクトをどう見せるか。親をたどり、カード・メモ・タブの決まりを当てる。
 * 索引に無いもの（まだ置いていないもの）は full。
 *
 * 親がまだ届いていなければ pending。親より先に子が届くことがあり（部屋の読み込みや複製では、
 * 送る順が入れ替わる）、そのまま full とみなすと、裏向きのカードの表や GM だけのメモが、決まりを
 * 当てる前に配られてしまう。親が届いたら、見え方を比べ直して渡す
 */
export const viewKind = (identifier: string, viewer: Viewer, lookup: Lookup): ViewKind => {
  const entry = lookup(identifier);
  if (!entry) return 'full';
  let kind = ownKind(entry.view, viewer);
  if (entry.view?.kind === 'reaction') {
    // まだ置いていない（か消えた）発言へのリアクションは、発言の見え方が決まるまで待つ
    if (!lookup(entry.view.message)) return 'pending';
    const message = viewKind(entry.view.message, viewer, lookup);
    if (!delivered(message)) return message;
  }

  // データ要素の名前を集めながら、決まりを持つ親までたどる
  const names = entry.view?.kind === 'data' ? [entry.view.name] : [];
  let current = entry;
  for (let depth = 0; depth < MAX_DEPTH && kind !== 'hidden'; depth++) {
    if (!current.parent) break;
    const parent = lookup(current.parent);
    if (!parent) return stricter(kind, 'pending');
    const view = parent.view;
    // 根のデータ要素（名前はオブジェクトの種類）を除いた、根からの道筋
    const path = names.slice(0, -1).reverse();
    if (
      view?.kind === 'tab' &&
      !(isGameMaster(viewer) || (viewer.role === 'guest' ? view.guest : view.pl))
    ) {
      return 'hidden';
    }
    if (view?.kind === 'card' && !seesFace(view, viewer) && hiddenUnderCard(path)) return 'hidden';
    if (view?.kind === 'die' && ownKind(view, viewer) === 'masked' && hiddenUnderDie(path))
      return 'hidden';
    if (view?.kind === 'note' && !seesDisclosed(view, viewer))
      kind = stricter(kind, kindUnderNote(path));
    if (view?.kind === 'data') names.push(view.name);
    current = parent;
  }
  return kind;
};

/** 伏せる文字。空白はそのまま残す（Axe のメモが伏せて描く形と同じ） */
const blackOut = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\S/g, '█') : value;

/** シークレットの発言で伏せるもの */
const SECRET_ATTRIBUTES = MASKED_CHAT_ATTRIBUTES;

/** 伏せたものを作る。種類ごとに伏せるところが違う */
export const masked = (context: ObjectContext): ObjectContext => {
  switch (context.aliasName) {
    case 'chat':
      return withAttributes(
        { ...context, syncData: { ...context.syncData, value: '' } },
        Object.fromEntries(SECRET_ATTRIBUTES.map((field) => [field, ''])),
      );
    case 'dice-symbol':
      return withAttributes(context, { face: '' });
    default:
      return withAttributes(
        { ...context, syncData: { ...context.syncData, value: blackOut(context.syncData.value) } },
        { currentValue: blackOut(attributesOf(context).currentValue) },
      );
  }
};

/**
 * 伏せたものを受け取っている人が書き戻してきたとき、伏せたところだけを置いてある中身に戻す。
 * 戻さないと、伏せた中身で本物を上書きされる
 */
export const unmasked = (incoming: ObjectContext, stored: ObjectContext): ObjectContext => {
  const kept = attributesOf(stored);
  switch (incoming.aliasName) {
    case 'chat':
      return withAttributes(
        { ...incoming, syncData: { ...incoming.syncData, value: stored.syncData.value } },
        Object.fromEntries(SECRET_ATTRIBUTES.map((field) => [field, kept[field]])),
      );
    case 'dice-symbol':
      return withAttributes(incoming, { face: kept.face });
    default:
      return withAttributes(
        { ...incoming, syncData: { ...incoming.syncData, value: stored.syncData.value } },
        { currentValue: kept.currentValue },
      );
  }
};

/**
 * 伏せた形の版の小数部。本物より小さくしておくと、見えるようになったとき、本物の版の方が新しいと
 * わかり、カタログの交換で取り直せる（同じ版だと、つなぎ直したあとも伏せたまま残る）
 */
export const maskedMinor = (minorVersion: number): number =>
  minorVersion > 0 ? minorVersion / 2 : -0.5;

/** その人に見せる形。見せないなら null。伏せた形には、本物より小さい版を付ける */
export const viewFor = (context: ObjectContext, kind: ViewKind): ObjectContext | null =>
  !delivered(kind)
    ? null
    : kind === 'masked'
      ? { ...masked(context), minorVersion: maskedMinor(context.minorVersion) }
      : context;
