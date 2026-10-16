export type AssetKind = 'image' | 'audio';

export interface SniffedType {
  kind: AssetKind;
  /** The Content-Type it is served with. */
  type: string;
}

/**
 * How many bytes from the start are read to decide. In an SVG the root element comes after the XML
 * declaration, comments and DOCTYPE, so it takes enough to read past them.
 */
export const SNIFF_BYTES = 4096;

/**
 * What comes before the root element and is read past when checking for an SVG (white space, the
 * XML declaration and processing instructions, comments, DOCTYPE). It is written so that repeats
 * next to each other never take the same characters, so that even something left unclosed is gone
 * over only once from the start.
 */
const XML_PROLOG = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\]\s*)?>)*/;

/**
 * The brands after `ftyp` that are accepted.
 * The same box also comes at the start of mp4 and mov videos, so they cannot be told apart without
 * reading as far as the brand.
 * For sounds only M4A (and M4B for audiobooks) is accepted, not isom or mp42, which videos use too.
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

/**
 * The lengths of the info header that comes right after a BMP's file header. With any other length
 * it cannot be read as a BMP.
 */
const BMP_INFO_HEADER_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * Decides from the start of the bytes whether they are a picture or a sound that is accepted. Null
 * when they are neither.
 *
 * It does not trust the declared Content-Type and looks only at the marks a format itself carries
 * at its start.
 * It does not check what comes after the marks, so it does not promise the contents are unbroken.
 * It is there to keep the Content-Type served to a fixed set of formats.
 * Scripts can be written inside an SVG, so an SVG is put in a sandbox when it is served
 * (response.ts).
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
  // An ID3v2 tag. The byte after it is the version (2 to 4).
  if (ascii(0, 3) === 'ID3' && head[3] >= 2 && head[3] <= 4) {
    return { kind: 'audio', type: 'audio/mpeg' };
  }
  if (isAdtsHeader(head)) return { kind: 'audio', type: 'audio/aac' };
  if (isMp3FrameHeader(head)) return { kind: 'audio', type: 'audio/mpeg' };
  if (isSvg(head)) return { kind: 'image', type: 'image/svg+xml' };
  return null;
};

/**
 * An SVG document: one whose root element starts with `<svg` once the BOM and what comes before
 * the root element are read past.
 * One whose prelude does not fit in the length read to decide is not taken as an SVG.
 */
const isSvg = (head: Uint8Array): boolean => {
  const text = new TextDecoder().decode(head);
  return /^<svg[\s>/]/.test(text.replace(XML_PROLOG, ''));
};

// ADTS (AAC) and MPEG audio frames both start with the sync bits (0xFFF, or 0xFFE for MPEG 2.5).
// The two layer bits in the second byte are 00 in ADTS and 01 in MP3.

/** An ADTS header: one whose sampling frequency index is 0 to 12. */
const isAdtsHeader = (head: Uint8Array): boolean =>
  head[0] === 0xff && (head[1] & 0xf6) === 0xf0 && ((head[2] >> 2) & 0x0f) <= 12;

/**
 * An MP3 (MPEG audio layer III) frame header.
 * Only one that uses no reserved value for the version, the bitrate or the sampling frequency.
 * This leaves out what merely happens to start with the sync bits, such as the UTF-16LE BOM
 * (FF FE).
 */
const isMp3FrameHeader = (head: Uint8Array): boolean => {
  if (head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false;
  const version = (head[1] >> 3) & 0x03;
  const layer = (head[1] >> 1) & 0x03;
  const bitrate = head[2] >> 4;
  const sampleRate = (head[2] >> 2) & 0x03;
  return version !== 0b01 && layer === 0b01 && bitrate !== 0x0f && sampleRate !== 0b11;
};
