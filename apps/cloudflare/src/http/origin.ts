export const tryParseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

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
