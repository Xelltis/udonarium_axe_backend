import { describe, expect, it } from 'vitest';

import { sniff } from '../../src/core/assets/sniff.js';

const bytes = (...values: (number | string)[]): Uint8Array =>
  new Uint8Array(
    values.flatMap((value) => (typeof value === 'string' ? [...value].map((char) => char.charCodeAt(0)) : [value]))
  );

/** BMP のファイルヘッダー（14バイト）と、長さ size の情報ヘッダーの書き出し */
const bmp = (infoHeaderSize: number) => bytes('BM', 0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, infoHeaderSize, 0, 0, 0);

describe('sniff', () => {
  it.each([
    ['png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a), 'image', 'image/png'],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image', 'image/jpeg'],
    ['gif87a', bytes('GIF87a'), 'image', 'image/gif'],
    ['gif89a', bytes('GIF89a'), 'image', 'image/gif'],
    ['bmp', bmp(40), 'image', 'image/bmp'],
    ['bmp v5', bmp(124), 'image', 'image/bmp'],
    ['webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '), 'image', 'image/webp'],
    ['avif', bytes(0, 0, 0, 0x1c, 'ftypavif'), 'image', 'image/avif'],
    ['heic', bytes(0, 0, 0, 0x18, 'ftypheic'), 'image', 'image/heic'],
    ['wav', bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt '), 'audio', 'audio/wav'],
    ['m4a', bytes(0, 0, 0, 0x20, 'ftypM4A '), 'audio', 'audio/mp4'],
    ['ogg', bytes('OggS', 0), 'audio', 'audio/ogg'],
    ['flac', bytes('fLaC', 0), 'audio', 'audio/flac'],
    ['mp3 with ID3', bytes('ID3', 4, 0), 'audio', 'audio/mpeg'],
    ['mp3 frame (MPEG-1)', bytes(0xff, 0xfb, 0x90, 0x64), 'audio', 'audio/mpeg'],
    ['mp3 frame (MPEG-2)', bytes(0xff, 0xf3, 0x90, 0x64), 'audio', 'audio/mpeg'],
    ['mp3 frame (MPEG-2.5)', bytes(0xff, 0xe3, 0x90, 0x64), 'audio', 'audio/mpeg'],
    ['aac adts', bytes(0xff, 0xf1, 0x50, 0x80), 'audio', 'audio/aac'],
  ])('reads %s', (_name, head, kind, type) => {
    expect(sniff(head)).toEqual({ kind, type });
  });

  it.each([
    ['bare', '<svg xmlns="http://www.w3.org/2000/svg">'],
    ['self-closing', '<svg/>'],
    ['after an XML declaration', '<?xml version="1.0" encoding="UTF-8"?>\n<svg>'],
    ['after a BOM', '\uFEFF<svg>'],
    ['after a comment', '<!-- Created with Inkscape -->\n<svg\n  width="10">'],
    [
      'after a DOCTYPE',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg>',
    ],
    ['after a DOCTYPE with entities', '<!DOCTYPE svg [\n  <!ENTITY ns "x">\n]>\n<svg>'],
    ['after every kind of prolog', '\t<?xml version="1.0"?><!--a--><?xml-stylesheet href="a"?>\n<!DOCTYPE svg><svg>'],
  ])('reads an SVG %s', (_name, text) => {
    expect(sniff(new TextEncoder().encode(text))).toEqual({ kind: 'image', type: 'image/svg+xml' });
  });

  it.each([
    ['xml prolog', bytes('<?xml version="1.0"?>')],
    ['html', bytes('<!DOCTYPE html>')],
    ['html with an svg inside', bytes('<!DOCTYPE html><html><svg></svg></html>')],
    ['xhtml', bytes('<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml">')],
    ['another element starting with svg', bytes('<svgx>')],
    ['svg inside an unclosed comment', bytes('<!-- <svg>')],
    ['svg after an unclosed DOCTYPE', bytes('<!DOCTYPE svg [ <svg>')],
    ['svg after text', bytes('hello <svg>')],
    ['zip', bytes('PK', 3, 4)],
    ['png signature cut short', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x00)],
    ['GIF8 without a version', bytes('GIF8xa')],
    ['text starting with BM', bytes('BMW drivers wanted: apply within')],
    ['mp4 video', bytes(0, 0, 0, 0x20, 'ftypisom')],
    ['mp4 (mp42)', bytes(0, 0, 0, 0x20, 'ftypmp42')],
    ['quicktime', bytes(0, 0, 0, 0x14, 'ftypqt  ')],
    ['3gp', bytes(0, 0, 0, 0x14, 'ftyp3gp4')],
    ['text starting with ID3', bytes('ID3 tags are metadata')],
    ['utf-16le text', bytes(0xff, 0xfe, 'h', 0, 'i', 0)],
    ['ff ff', bytes(0xff, 0xff, 0xff, 0xff)],
    ['mpeg layer I frame', bytes(0xff, 0xff, 0x90, 0x64)],
    ['mpeg layer II frame', bytes(0xff, 0xfd, 0x90, 0x64)],
    ['mpeg frame with a reserved version', bytes(0xff, 0xeb, 0x90, 0x64)],
    ['mpeg frame with a bad bitrate', bytes(0xff, 0xfb, 0xf0, 0x64)],
    ['mpeg frame with a reserved sample rate', bytes(0xff, 0xfb, 0x9c, 0x64)],
    ['adts with a reserved sample rate', bytes(0xff, 0xf1, 0x74, 0x80)],
    ['too short', bytes(0x89, 'P')],
    ['empty', bytes()],
  ])('turns away %s', (_name, head) => {
    expect(sniff(head)).toBeNull();
  });
});
