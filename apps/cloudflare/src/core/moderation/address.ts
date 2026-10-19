/**
 * IP addresses and the ranges an operator bans them by.
 *
 * A range is written as an address with a prefix length (CIDR). Without one, an IPv4 address bans
 * that address alone, and an IPv6 address bans its leading /64, the unit the rate limits count by
 * (an IPv6 user usually has a whole /64).
 */

/** The shortest prefix a range may have. Shorter would ban a large part of the internet by mistake. */
export const MIN_PREFIX = { 4: 8, 6: 16 } as const;

/** The prefix an address written without one is given. */
const DEFAULT_PREFIX = { 4: 32, 6: 64 } as const;

const WIDTH = { 4: 32, 6: 128 } as const;

type Version = 4 | 6;

/** An address as a number. An IPv4 address inside IPv6 (::ffff:192.0.2.1) is taken as that IPv4 address. */
interface Address {
  version: Version;
  bits: bigint;
}

/** A range of addresses, read from a rule. */
export interface AddressRange extends Address {
  prefix: number;
}

const parseIpv4 = (text: string): bigint | null => {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let bits = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    bits = (bits << 8n) | BigInt(part);
  }
  return bits;
};

const parseIpv6 = (text: string): bigint | null => {
  let head = text;
  let ipv4: bigint | null = null;
  // The last 32 bits can be written as an IPv4 address (::ffff:192.0.2.1).
  if (text.includes('.')) {
    const at = text.lastIndexOf(':');
    ipv4 = parseIpv4(text.slice(at + 1));
    if (ipv4 === null) return null;
    head = `${text.slice(0, at + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  // Without ::, all eight groups are written. With it, it stands for at least one.
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  let bits = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    bits = (bits << 16n) | BigInt(parseInt(group, 16));
  }
  return ipv4 === null ? bits : bits | ipv4;
};

const MAPPED_IPV4 = 0xffffn;

/** Reads an address. Null when it is not one (such as `unknown`, when the platform gave none). */
export const parseAddress = (text: string): Address | null => {
  // A zone (fe80::1%eth0) says which interface, not which host.
  const bare = text.trim().split('%')[0];
  if (!bare.includes(':')) {
    const bits = parseIpv4(bare);
    return bits === null ? null : { version: 4, bits };
  }
  const bits = parseIpv6(bare);
  if (bits === null) return null;
  return bits >> 32n === MAPPED_IPV4 ? { version: 4, bits: bits & 0xffffffffn } : { version: 6, bits };
};

const maskOf = (version: Version, prefix: number): bigint => {
  const width = BigInt(WIDTH[version]);
  return ((1n << width) - 1n) ^ ((1n << (width - BigInt(prefix))) - 1n);
};

/**
 * Reads a rule: an address, or an address with a prefix length. The host part is cleared
 * (203.0.113.5/24 is 203.0.113.0/24). Null when it is not one, or its prefix is out of range.
 */
export const parseRange = (text: string): AddressRange | null => {
  const [address, prefixText, ...rest] = text.trim().split('/');
  if (rest.length > 0) return null;
  const parsed = parseAddress(address);
  if (!parsed) return null;
  // An IPv4 address written inside IPv6 is ranged as IPv4, so its prefix is counted as IPv4's.
  const version = parsed.version;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? DEFAULT_PREFIX[version] : Number(prefixText);
  if (prefix < MIN_PREFIX[version] || prefix > WIDTH[version]) return null;
  return { version, bits: parsed.bits & maskOf(version, prefix), prefix };
};

const formatIpv6 = (bits: bigint): string => {
  const groups = Array.from({ length: 8 }, (_, index) => Number((bits >> BigInt(112 - index * 16)) & 0xffffn));
  // The longest run of two or more zero groups is written as :: (the first, when runs tie).
  let best = { start: -1, length: 1 };
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length++;
    if (length > best.length) best = { start, length };
  }
  const hex = groups.map((group) => group.toString(16));
  if (best.start < 0) return hex.join(':');
  const left = hex.slice(0, best.start).join(':');
  const right = hex.slice(best.start + best.length).join(':');
  return `${left}::${right}`;
};

/** Writes a range the one way it is kept and shown (203.0.113.0/24, 2001:db8::/64). */
export const formatRange = (range: AddressRange): string => {
  const address =
    range.version === 4
      ? [24n, 16n, 8n, 0n].map((shift) => String((range.bits >> shift) & 0xffn)).join('.')
      : formatIpv6(range.bits);
  return `${address}/${range.prefix}`;
};

/** Whether the address is in the range. */
export const inRange = (range: AddressRange, address: string): boolean => {
  const parsed = parseAddress(address);
  return (
    parsed !== null &&
    parsed.version === range.version &&
    (parsed.bits & maskOf(range.version, range.prefix)) === range.bits
  );
};
