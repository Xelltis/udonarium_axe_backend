/** アセットの名前。中身の SHA-256 を小文字の16進で書いたもの */
export const ASSET_ID = /^[0-9a-f]{64}$/;

/** 部屋ごとのアセットを置く場所の頭 */
export const ROOMS_PREFIX = 'rooms/';

/** 部屋のアセットの置き場所。部屋ごとに分け、部屋が消えるときにまとめて消す */
export const roomAssetPrefix = (roomKey: string): string => `${ROOMS_PREFIX}${roomKey}/`;

export const roomAssetKey = (roomKey: string, id: string): string =>
  `${roomAssetPrefix(roomKey)}${id}`;

/** 置き場所から、その部屋の鍵を取り出す。部屋のアセットでなければ null */
export const roomKeyOf = (key: string): string | null => {
  if (!key.startsWith(ROOMS_PREFIX)) return null;
  const roomKey = key.slice(ROOMS_PREFIX.length).split('/')[0];
  return roomKey.length > 0 ? roomKey : null;
};

/**
 * 置かせないアセットの印。権利侵害の申し立てなどで消したものを、また上げさせないために置く。
 * 中身は空で、名前だけに意味がある（運用は README の「特定の画像を消したいとき」）。部屋にかかわらず効く
 */
export const blockedKeyOf = (id: string): string => `blocked/${id}`;
