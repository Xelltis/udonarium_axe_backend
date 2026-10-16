/**
 * 送信元の IP アドレスを、レート制限で数える単位にする。
 *
 * IPv4 はアドレスそのまま、IPv6 は先頭の /64 にまとめる。IPv6 の利用者はふつう /64 を丸ごと
 * 持っていて、その中でアドレスを替えるだけで別の送信元として数えられてしまうため。
 */
export const networkOf = (address: string): string => {
  if (!address.includes(':')) return address;
  // ::ffff:192.0.2.1 のように IPv4 を埋め込んだものは、その IPv4 として数える
  if (address.includes('.')) return address.slice(address.lastIndexOf(':') + 1);

  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  const groups = [...left, ...zeros, ...right].slice(0, 4);
  return `${groups.map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
};
