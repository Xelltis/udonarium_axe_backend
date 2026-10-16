import { MAX_ASSET_NAME_LENGTH } from '../../../contracts/protocol.js';

/** PUT に付いてきた名前。読めなければ空、長ければ切る。2つで1文字のものを半分で切らない */
export const assetNameOf = (header: string): string => {
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    return '';
  }
  if (name.length <= MAX_ASSET_NAME_LENGTH) return name;
  name = name.slice(0, MAX_ASSET_NAME_LENGTH);
  return /[\uD800-\uDBFF]$/.test(name) ? name.slice(0, -1) : name;
};
