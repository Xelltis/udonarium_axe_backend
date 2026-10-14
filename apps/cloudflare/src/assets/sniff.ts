export type AssetKind = 'image' | 'audio';

export interface SniffedType {
  kind: AssetKind;
  /** 配信するときの Content-Type */
  type: string;
}

/** 判定に読む先頭のバイト数 */
export const SNIFF_BYTES = 16;

/**
 * `ftyp` の後ろのブランドのうち、動画や音声ではなく静止画を表すもの。
 * 同じ箱が mp4 の先頭にも来るので、ブランドまで読まないと区別できない。
 */
const PICTURE_BRANDS: ReadonlyMap<string, string> = new Map([
  ['avif', 'image/avif'],
  ['avis', 'image/avif'],
  ['heic', 'image/heic'],
  ['heix', 'image/heic'],
  ['hevc', 'image/heic'],
  ['hevx', 'image/heic'],
  ['heim', 'image/heif'],
  ['heis', 'image/heif'],
  ['mif1', 'image/heif'],
  ['msf1', 'image/heif'],
]);

/**
 * バイト列の先頭から、受け付ける画像か音声かを判定する。どれでもなければ null。
 *
 * 宣言された Content-Type は信じず、形式そのものが先頭に持つ印だけを見る。
 * SVG は中にスクリプトを書けるので受け付けない（クライアントは P2P で配る）。
 */
export const sniff = (head: Uint8Array): SniffedType | null => {
  if (head.length < 4) return null;
  const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  const ascii = (from: number, length: number) =>
    String.fromCharCode(...head.subarray(from, from + length));

  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: 'image', type: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'image', type: 'image/jpeg' };
  if (ascii(0, 4) === 'GIF8') return { kind: 'image', type: 'image/gif' };
  if (ascii(0, 2) === 'BM') return { kind: 'image', type: 'image/bmp' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP')
    return { kind: 'image', type: 'image/webp' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { kind: 'audio', type: 'audio/wav' };
  if (ascii(4, 4) === 'ftyp') {
    const picture = PICTURE_BRANDS.get(ascii(8, 4));
    return picture ? { kind: 'image', type: picture } : { kind: 'audio', type: 'audio/mp4' };
  }
  if (ascii(0, 4) === 'OggS') return { kind: 'audio', type: 'audio/ogg' };
  if (ascii(0, 4) === 'fLaC') return { kind: 'audio', type: 'audio/flac' };
  if (ascii(0, 3) === 'ID3') return { kind: 'audio', type: 'audio/mpeg' };
  // ADTS（AAC）と MPEG オーディオはどちらもフレーム同期の 0xFFF から始まる。
  // レイヤーの2ビットが 00 なら ADTS、それ以外なら MP3 などのフレーム。
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return { kind: 'audio', type: 'audio/aac' };
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) {
    return { kind: 'audio', type: 'audio/mpeg' };
  }
  return null;
};
