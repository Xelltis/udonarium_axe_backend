<?php

declare(strict_types=1);

/**
 * A class with utility methods for URLs and origins.
 *
 * It checks origins for CORS and parses origin strings.
 */
final class UrlUtils
{
    /** @codeCoverageIgnore */
    private function __construct() {}

    /**
     * Turns a comma-separated string of origins into an array.
     *
     * Returns an empty array for an empty string or a string of only whitespace.
     * Each item has the whitespace around it trimmed, and empty items are left out.
     *
     * @param string $origins The origins, as a comma-separated string.
     *
     * @return string[] The trimmed origins.
     */
    public static function parseAllowedOrigins(string $origins): array
    {
        if (trim($origins) === '') {
            return [];
        }

        return array_values(array_filter(array_map('trim', explode(',', $origins))));
    }

    /**
     * Checks whether the request's origin is on the allow list.
     *
     * It allows the origin only when the host, scheme and port all match.
     * When the list has the wildcard "*" in it, every origin is allowed.
     *
     * @param string   $requestOrigin  The value of the request's Origin header to check.
     * @param string[] $allowedOrigins The list of allowed origins.
     *
     * @return bool True when it is allowed.
     */
    public static function isAllowedOrigin(string $requestOrigin, array $allowedOrigins): bool
    {
        return self::findMatchedOrigin($requestOrigin, $allowedOrigins) !== null;
    }

    /**
     * When the request's origin is on the allow list, returns the allow list's string for it.
     *
     * Returns null when nothing matches.
     * Always use this return value (the string the administrator set) in response headers.
     * Sending the request's raw string back in a header as it is risks HTTP header injection.
     *
     * @param string   $requestOrigin  The value of the request's Origin header to check.
     * @param string[] $allowedOrigins The list of allowed origins.
     *
     * @return string|null The allowed origin string that matched, or null.
     */
    public static function findMatchedOrigin(string $requestOrigin, array $allowedOrigins): ?string
    {
        if (in_array('*', $allowedOrigins, true)) {
            return '*';
        }

        $requestParsed = parse_url($requestOrigin);
        if (!is_array($requestParsed) || !isset($requestParsed['host'])) {
            return null;
        }

        foreach ($allowedOrigins as $allowed) {
            if (self::originMatches($requestParsed, $allowed)) {
                // Returns the string the administrator set, not the request's raw string.
                return $allowed;
            }
        }

        return null;
    }

    /**
     * Tells whether a parsed request origin matches an allowed origin string.
     *
     * @param array<string, int|string> $requestParsed The request origin, split up by parse_url().
     * @param string                    $allowed       The allowed origin string.
     */
    private static function originMatches(array $requestParsed, string $allowed): bool
    {
        $allowedParsed = parse_url($allowed);
        if (!is_array($allowedParsed) || !isset($allowedParsed['host'])) {
            return false;
        }

        return $requestParsed['host']       === $allowedParsed['host']
            && ($requestParsed['scheme'] ?? '') === ($allowedParsed['scheme'] ?? '')
            && ($requestParsed['port']   ?? '') === ($allowedParsed['port']   ?? '');
    }
}
