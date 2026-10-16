import { ASSET_ID, ROOMS_PREFIX, roomAssetPrefix, roomKeyOf } from '../core/assets/keys';

/** 1回の掃除で見るオブジェクトの数。R2 の list と delete が一度に扱える上限 */
const SWEEP_PAGE_SIZE = 1000;

/** 部屋が見当たらなくても、置いてからこの時間は消さない。部屋を作るのと置くのが前後しても消さないため */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** 掃除を始める位置。部屋の鍵と同じ形の乱数 */
export const randomStart = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * 部屋のアセットをすべて消す。部屋を削除したときと、保持期間が過ぎて部屋を消すときに呼ぶ。
 * 消した数を返す
 */
export const deleteRoomAssets = async (bucket: R2Bucket, roomKey: string): Promise<number> => {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: roomAssetPrefix(roomKey),
      limit: SWEEP_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
};

/**
 * start の後ろから1ページ分を見て、部屋がもう無いアセットを消す。消した数を返す。
 * 部屋が消えるときに消しそこねたもの（途中で落ちたときなど）を拾う。
 *
 * 部屋の鍵は乱数なので、始める位置を毎回ランダムに選べば、どこまで見たかを覚えておかなくても、
 * いずれバケット全体を見て回れる。部屋に分ける前の、部屋に属さないアセット（名前だけのもの）も消す
 */
export const sweepOrphans = async (
  bucket: R2Bucket,
  knownRooms: (roomKeys: string[]) => Promise<string[]>,
  start: string
): Promise<number> => {
  const { objects } = await bucket.list({
    prefix: ROOMS_PREFIX,
    startAfter: `${ROOMS_PREFIX}${start}`,
    limit: SWEEP_PAGE_SIZE,
  });
  const roomKeys = [...new Set(objects.map((object) => roomKeyOf(object.key) as string))];
  const known = new Set(roomKeys.length > 0 ? await knownRooms(roomKeys) : []);
  const now = Date.now();
  const orphans = objects
    .filter((object) => !known.has(roomKeyOf(object.key) as string))
    .filter((object) => now - object.uploaded.getTime() > ORPHAN_GRACE_MS)
    .map((object) => object.key);

  // 部屋に分ける前のものは、名前（64 桁の16進）だけでバケットの頭に並んでいる
  const unscoped = await bucket.list({ startAfter: start, limit: SWEEP_PAGE_SIZE });
  const legacy = unscoped.objects.map((object) => object.key).filter((key) => ASSET_ID.test(key));

  const doomed = [...orphans, ...legacy];
  if (doomed.length > 0) await bucket.delete(doomed);
  return doomed.length;
};
