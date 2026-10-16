export type AssetKind = 'image' | 'audio';

export interface SniffedType {
  kind: AssetKind;
  /** 配信するときの Content-Type */
  type: string;
}

/**
 * 判定に読む先頭のバイト数。SVG は XML 宣言・コメント・DOCTYPE のあとにルート要素が来るので、
 * それらを読み飛ばせるだけの長さを取る
 */
export const SNIFF_BYTES = 4096;

/**
 * SVG の判定で読み飛ばす、ルート要素より前のもの（空白、XML 宣言と処理命令、コメント、DOCTYPE）。
 * 閉じていないものを渡されても先頭から1度なぞるだけで済むよう、隣りあう繰り返しが同じ文字を
 * 取りあわない形にしてある
 */
const XML_PROLOG = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\]\s*)?>)*/;

/**
 * `ftyp` の後ろのブランドのうち、受け付けるもの。
 * 同じ箱が mp4 や mov の動画の先頭にも来るので、ブランドまで読まないと区別できない。
 * 音声は M4A（とオーディオブックの M4B）だけで、動画にも使われる isom や mp42 は受け付けない。
 */
const FTYP_BRANDS: ReadonlyMap<string, SniffedType> = new Map([
  ['avif', { kind: 'image', type: 'image/avif' }],
  ['avis', { kind: 'image', type: 'image/avif' }],
  ['heic', { kind: 'image', type: 'image/heic' }],
  ['heix', { kind: 'image', type: 'image/heic' }],
  ['hevc', { kind: 'image', type: 'image/heic' }],
  ['hevx', { kind: 'image', type: 'image/heic' }],
  ['heim', { kind: 'image', type: 'image/heif' }],
  ['heis', { kind: 'image', type: 'image/heif' }],
  ['mif1', { kind: 'image', type: 'image/heif' }],
  ['msf1', { kind: 'image', type: 'image/heif' }],
  ['M4A ', { kind: 'audio', type: 'audio/mp4' }],
  ['M4B ', { kind: 'audio', type: 'audio/mp4' }],
]);

/** BMP のファイルヘッダーの直後に来る情報ヘッダーの長さ。これ以外は BMP として読めない */
const BMP_INFO_HEADER_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * バイト列の先頭から、受け付ける画像か音声かを判定する。どれでもなければ null。
 *
 * 宣言された Content-Type は信じず、形式そのものが先頭に持つ印だけを見る。
 * 印のあとに何が続くかまでは確かめないので、中身が壊れていないことの保証にはならない。
 * 配信する Content-Type を、決まった形式に限るための判定。
 * SVG は中にスクリプトを書けるので、配るときにサンドボックスに入れる（response.ts）。
 */
export const sniff = (head: Uint8Array): SniffedType | null => {
  if (head.length < 4) return null;
  const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  const ascii = (from: number, length: number) => String.fromCharCode(...head.subarray(from, from + length));
  const uint32le = (from: number) =>
    (head[from] | (head[from + 1] << 8) | (head[from + 2] << 16) | (head[from + 3] << 24)) >>> 0;

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { kind: 'image', type: 'image/png' };
  }
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'image', type: 'image/jpeg' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
    return { kind: 'image', type: 'image/gif' };
  }
  if (ascii(0, 2) === 'BM' && BMP_INFO_HEADER_SIZES.has(uint32le(14))) {
    return { kind: 'image', type: 'image/bmp' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return { kind: 'image', type: 'image/webp' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { kind: 'audio', type: 'audio/wav' };
  if (ascii(4, 4) === 'ftyp') return FTYP_BRANDS.get(ascii(8, 4)) ?? null;
  if (ascii(0, 4) === 'OggS') return { kind: 'audio', type: 'audio/ogg' };
  if (ascii(0, 4) === 'fLaC') return { kind: 'audio', type: 'audio/flac' };
  // ID3v2 のタグ。続く1バイトが版（2〜4）
  if (ascii(0, 3) === 'ID3' && head[3] >= 2 && head[3] <= 4) {
    return { kind: 'audio', type: 'audio/mpeg' };
  }
  if (isAdtsHeader(head)) return { kind: 'audio', type: 'audio/aac' };
  if (isMp3FrameHeader(head)) return { kind: 'audio', type: 'audio/mpeg' };
  if (isSvg(head)) return { kind: 'image', type: 'image/svg+xml' };
  return null;
};

/**
 * SVG の文書。BOM と、ルート要素より前のものを読み飛ばし、ルート要素が `<svg` で始まるもの。
 * 前置きが判定に読む長さに収まらないものは、SVG と見なさない。
 */
const isSvg = (head: Uint8Array): boolean => {
  const text = new TextDecoder().decode(head);
  return /^<svg[\s>/]/.test(text.replace(XML_PROLOG, ''));
};

// ADTS（AAC）と MPEG オーディオのフレームは、どちらも同期ビット（0xFFF、MPEG 2.5 は 0xFFE）で
// 始まる。2バイト目にあるレイヤーの2ビットが、ADTS では 00、MP3 では 01 になる。

/** ADTS のヘッダー。サンプリング周波数の番号が 0〜12 のもの */
const isAdtsHeader = (head: Uint8Array): boolean =>
  head[0] === 0xff && (head[1] & 0xf6) === 0xf0 && ((head[2] >> 2) & 0x0f) <= 12;

/**
 * MP3（MPEG オーディオのレイヤー III）のフレームヘッダー。
 * 版・ビットレート・サンプリング周波数のどれにも予約済みの値を使っていないものだけ。
 * UTF-16LE の BOM（FF FE）のように、たまたま同期ビットで始まるだけのものを除く。
 */
const isMp3FrameHeader = (head: Uint8Array): boolean => {
  if (head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false;
  const version = (head[1] >> 3) & 0x03;
  const layer = (head[1] >> 1) & 0x03;
  const bitrate = head[2] >> 4;
  const sampleRate = (head[2] >> 2) & 0x03;
  return version !== 0b01 && layer === 0b01 && bitrate !== 0x0f && sampleRate !== 0b11;
};
