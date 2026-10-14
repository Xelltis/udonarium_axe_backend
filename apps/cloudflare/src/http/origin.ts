const tryParseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** カンマ区切りの許可リストを、空の項目を除いた配列にする。 */
export const parseAllowedOrigins = (raw: string): string[] =>
  raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/**
 * Origin が許可リストに入っているか。
 *
 * スキーム・ホスト名・ポートがすべて一致したときだけ許可する。パスや末尾のスラッシュの違いは見ない。
 */
export const isAllowedOrigin = (
  requestOrigin: string | undefined,
  allowedOrigins: string[],
): boolean => {
  if (allowedOrigins.includes('*')) return true;
  const requested = tryParseUrl(requestOrigin ?? '');
  if (!requested) return false;
  return allowedOrigins.some((origin) => {
    const allowed = tryParseUrl(origin);
    return (
      allowed !== null &&
      allowed.hostname === requested.hostname &&
      allowed.protocol === requested.protocol &&
      allowed.port === requested.port
    );
  });
};
