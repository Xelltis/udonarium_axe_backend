import { MAX_ASSET_NAME_LENGTH } from '../../../contracts/protocol.js';

/**
 * The name that came with a PUT. Empty when it cannot be read, and cut short when it is too long.
 * A character made of two halves is never cut in the middle. A half that came alone (JSON can carry
 * one) becomes U+FFFD, since it cannot be written into the header the asset is served with.
 */
export const assetNameOf = (header: string): string => {
  let name: string;
  try {
    name = decodeURIComponent(header).toWellFormed();
  } catch {
    return '';
  }
  if (name.length <= MAX_ASSET_NAME_LENGTH) return name;
  name = name.slice(0, MAX_ASSET_NAME_LENGTH);
  return /[\uD800-\uDBFF]$/.test(name) ? name.slice(0, -1) : name;
};
