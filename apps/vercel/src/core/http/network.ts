/**
 * Turns the sender's IP address into the unit that rate limits count by.
 *
 * IPv4 keeps the address as it is, and IPv6 is grouped into its leading /64. An IPv6 user usually
 * has a whole /64, and would be counted as a different sender just by changing addresses inside it.
 */
export const networkOf = (address: string): string => {
  if (!address.includes(':')) return address;
  // An address with an IPv4 address inside, such as ::ffff:192.0.2.1, counts as that IPv4 address.
  if (address.includes('.')) return address.slice(address.lastIndexOf(':') + 1);

  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  const groups = [...left, ...zeros, ...right].slice(0, 4);
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
};
