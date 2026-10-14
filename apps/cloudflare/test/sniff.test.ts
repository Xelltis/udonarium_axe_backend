import { describe, expect, it } from 'vitest';

import { sniff } from '../src/assets/sniff';

const bytes = (...values: (number | string)[]): Uint8Array =>
  new Uint8Array(
    values.flatMap((value) =>
      typeof value === 'string' ? [...value].map((char) => char.charCodeAt(0)) : [value],
    ),
  );

describe('sniff', () => {
  it.each([
    ['png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a), 'image', 'image/png'],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), 'image', 'image/jpeg'],
    ['gif', bytes('GIF89a'), 'image', 'image/gif'],
    ['bmp', bytes('BM', 0, 0), 'image', 'image/bmp'],
    ['webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '), 'image', 'image/webp'],
    ['avif', bytes(0, 0, 0, 0x1c, 'ftypavif'), 'image', 'image/avif'],
    ['heic', bytes(0, 0, 0, 0x18, 'ftypheic'), 'image', 'image/heic'],
    ['wav', bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt '), 'audio', 'audio/wav'],
    ['m4a', bytes(0, 0, 0, 0x20, 'ftypM4A '), 'audio', 'audio/mp4'],
    ['ogg', bytes('OggS', 0), 'audio', 'audio/ogg'],
    ['flac', bytes('fLaC', 0), 'audio', 'audio/flac'],
    ['mp3 with ID3', bytes('ID3', 4, 0), 'audio', 'audio/mpeg'],
    ['mp3 frame', bytes(0xff, 0xfb, 0x90, 0x64), 'audio', 'audio/mpeg'],
    ['aac adts', bytes(0xff, 0xf1, 0x50, 0x80), 'audio', 'audio/aac'],
  ])('reads %s', (_name, head, kind, type) => {
    expect(sniff(head)).toEqual({ kind, type });
  });

  it.each([
    ['svg', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['xml prolog', bytes('<?xml version="1.0"?>')],
    ['html', bytes('<!DOCTYPE html>')],
    ['zip', bytes('PK', 3, 4)],
    ['too short', bytes(0x89, 'P')],
    ['empty', bytes()],
  ])('turns away %s', (_name, head) => {
    expect(sniff(head)).toBeNull();
  });
});
