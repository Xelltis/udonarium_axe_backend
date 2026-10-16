import { describe, expect, it } from 'vitest';

import { roomKeyOf } from '../../src/core/assets/keys.js';
import { networkOf } from '../../src/core/http/network.js';
import { isAllowedOrigin } from '../../src/core/http/origin.js';

describe('networkOf', () => {
  it.each([
    ['192.0.2.1', '192.0.2.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002::0005', '2001:db8:1:2::/64'],
    ['2001:DB8::1', '2001:db8:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
  ])('counts %s as %s', (address, network) => {
    expect(networkOf(address)).toBe(network);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = ['https://app.example', 'http://localhost:4200', 'not a url'];

  it.each([
    ['https://app.example', true],
    ['https://app.example/', true],
    ['http://app.example', false],
    ['https://app.example:8443', false],
    ['http://localhost:4200', true],
    ['http://localhost:4300', false],
    ['not a url', false],
    [undefined, false],
  ])('answers %s with %s', (origin, expected) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(expected);
  });

  it('lets every origin in with *', () => {
    expect(isAllowedOrigin('https://anywhere.example', ['*'])).toBe(true);
  });
});

describe('roomKeyOf', () => {
  it('reads the room out of where a room asset is kept, and nothing out of anything else', () => {
    expect(roomKeyOf(`rooms/${'a'.repeat(32)}/${'b'.repeat(64)}`)).toBe('a'.repeat(32));
    expect(roomKeyOf('b'.repeat(64))).toBeNull();
    expect(roomKeyOf(`blocked/${'b'.repeat(64)}`)).toBeNull();
    expect(roomKeyOf('rooms//x')).toBeNull();
  });
});
