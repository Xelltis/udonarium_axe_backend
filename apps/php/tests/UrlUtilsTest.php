<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see UrlUtils}.
 *
 * They test parsing origin strings with parseAllowedOrigins(),
 * deciding what is allowed with isAllowedOrigin(), and finding a match with findMatchedOrigin().
 */
class UrlUtilsTest extends TestCase
{
    // ─── parseAllowedOrigins ─────────────────────────────────────────────────

    /**
     * Checks that a single origin string comes back as an array of one item.
     */
    public function testParseAllowedOriginsReturnsSingleOrigin(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://example.com');
        $this->assertSame(['https://example.com'], $result);
    }

    /**
     * Checks that several comma-separated origins are parsed correctly into an array.
     */
    public function testParseAllowedOriginsReturnsMultipleOrigins(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://example.com,https://www.example.com');
        $this->assertSame(['https://example.com', 'https://www.example.com'], $result);
    }

    /**
     * Checks that whitespace around the commas is trimmed.
     */
    public function testParseAllowedOriginsTrimsWhitespace(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://example.com , https://www.example.com');
        $this->assertSame(['https://example.com', 'https://www.example.com'], $result);
    }

    // ─── isAllowedOrigin ─────────────────────────────────────────────────────

    /**
     * Checks that it returns true for an origin on the allow list.
     */
    public function testIsAllowedOriginReturnsTrueForMatchingOrigin(): void
    {
        $this->assertTrue(
            UrlUtils::isAllowedOrigin('https://example.com', ['https://example.com']),
        );
    }

    /**
     * Checks that it returns false for an origin not on the allow list.
     */
    public function testIsAllowedOriginReturnsFalseForNonMatchingOrigin(): void
    {
        $this->assertFalse(
            UrlUtils::isAllowedOrigin('https://evil.com', ['https://example.com']),
        );
    }

    /**
     * Checks that the wildcard '*' allows any origin.
     */
    public function testIsAllowedOriginReturnsTrueForWildcard(): void
    {
        $this->assertTrue(
            UrlUtils::isAllowedOrigin('https://any.thing', ['*']),
        );
    }

    // ─── findMatchedOrigin ───────────────────────────────────────────────────

    /**
     * Checks that, on a match, the string from the allow list is returned as it is.
     */
    public function testFindMatchedOriginReturnsAllowedString(): void
    {
        // What comes back must be the string the administrator set.
        $result = UrlUtils::findMatchedOrigin(
            'https://example.com',
            ['https://example.com'],
        );
        $this->assertSame('https://example.com', $result);
    }

    /**
     * Checks that it returns null when no origin matches.
     */
    public function testFindMatchedOriginReturnsNullForNoMatch(): void
    {
        $result = UrlUtils::findMatchedOrigin(
            'https://evil.com',
            ['https://example.com'],
        );
        $this->assertNull($result);
    }

    /**
     * Checks that the literal string '*' is returned when the wildcard matches.
     */
    public function testFindMatchedOriginReturnsWildcardLiteralString(): void
    {
        $result = UrlUtils::findMatchedOrigin('https://any.com', ['*']);
        $this->assertSame('*', $result);
    }

    /**
     * Checks that it returns null when given an invalid URL.
     */
    public function testFindMatchedOriginRejectsInvalidUrl(): void
    {
        $result = UrlUtils::findMatchedOrigin('not-a-url', ['https://example.com']);
        $this->assertNull($result);
    }

    /**
     * Checks that it does not match when the scheme differs (http vs https).
     */
    public function testFindMatchedOriginDistinguishesByScheme(): void
    {
        $result = UrlUtils::findMatchedOrigin(
            'http://example.com',
            ['https://example.com'],
        );
        $this->assertNull($result);
    }

    /**
     * Checks that it does not match when the port number differs.
     */
    public function testFindMatchedOriginDistinguishesByPort(): void
    {
        $result = UrlUtils::findMatchedOrigin(
            'https://example.com:8080',
            ['https://example.com'],
        );
        $this->assertNull($result);
    }

    /**
     * Checks that it matches when an explicit port number is the same.
     */
    public function testFindMatchedOriginMatchesWithExplicitPort(): void
    {
        $result = UrlUtils::findMatchedOrigin(
            'https://example.com:8080',
            ['https://example.com:8080'],
        );
        $this->assertSame('https://example.com:8080', $result);
    }

    /**
     * Checks that an empty string gives an empty array.
     */
    public function testParseAllowedOriginsReturnsEmptyArrayForEmptyString(): void
    {
        $result = UrlUtils::parseAllowedOrigins('');
        $this->assertSame([], $result);
    }

    /**
     * Checks that a string of only whitespace gives an empty array.
     */
    public function testParseAllowedOriginsReturnsEmptyArrayForWhitespaceOnly(): void
    {
        $result = UrlUtils::parseAllowedOrigins('   ');
        $this->assertSame([], $result);
    }

    /**
     * Checks that empty entries between commas are filtered out.
     */
    public function testParseAllowedOriginsFiltersEmptyEntries(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://a.com,,https://b.com');
        $this->assertSame(['https://a.com', 'https://b.com'], $result);
    }

    // ─── findMatchedOrigin: malformed allowed origin ─────────────────────────

    /**
     * Checks that an invalid URL on the allow list is skipped and the match still works.
     */
    public function testFindMatchedOriginSkipsMalformedAllowedOrigin(): void
    {
        // Even when an origin on the allow list is an invalid URL, the other entries are evaluated.
        $result = UrlUtils::findMatchedOrigin(
            'https://example.com',
            ['not-valid', 'https://example.com'],
        );
        $this->assertSame('https://example.com', $result);
    }
}
