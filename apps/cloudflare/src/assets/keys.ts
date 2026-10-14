/** アセットの名前。中身の SHA-256 を小文字の16進で書いたもの */
export const ASSET_ID = /^[0-9a-f]{64}$/;

/**
 * 置かせないアセットの印。権利侵害の申し立てなどで消したものを、また上げさせないために置く。
 * 中身は空で、名前だけに意味がある（運用は README の「特定の画像を消したいとき」）
 */
export const blockedKeyOf = (id: string): string => `blocked/${id}`;
