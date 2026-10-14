import { ASSET_ID } from './keys';
import { remainingSeconds } from './response';

/** 1回の掃除で見るオブジェクトの数。R2 の list と delete が一度に扱える上限 */
const SWEEP_PAGE_SIZE = 1000;

/** 掃除を始める位置。名前と同じ形の乱数 */
export const randomStart = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

/**
 * start の後ろから1ページ分を見て、保持期間を過ぎたものをバケットから消す。消した数を返す。
 *
 * 名前は中身の SHA-256 なので、バケットの中に一様に散らばっている。始める位置を毎回ランダムに
 * 選べば、どこまで見たかを覚えておかなくても、いずれバケット全体を見て回れる。
 * 一覧を取ってから消すまでの間に上げ直されたものは消えてしまうが、そのときは次に部屋を
 * 読み込んだときにまた上がる。
 */
export const sweepExpired = async (
  bucket: R2Bucket,
  retentionSeconds: number,
  start: string,
): Promise<number> => {
  const { objects } = await bucket.list({ startAfter: start, limit: SWEEP_PAGE_SIZE });
  // 置かせないものの印（blocked/…）は消さない
  const expired = objects
    .filter((object) => ASSET_ID.test(object.key))
    .filter((object) => remainingSeconds(object, retentionSeconds) <= 0)
    .map((object) => object.key);
  if (expired.length > 0) await bucket.delete(expired);
  return expired.length;
};
