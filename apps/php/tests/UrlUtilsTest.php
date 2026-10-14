<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see UrlUtils} のテストケース。
 *
 * parseAllowedOrigins() によるオリジン文字列パース、
 * isAllowedOrigin() による許可判定、findMatchedOrigin() によるマッチ検索を検証する。
 */
class UrlUtilsTest extends TestCase
{
    // ─── parseAllowedOrigins ─────────────────────────────────────────────────

    /**
     * 単一のオリジン文字列が 1 要素の配列として返されることを確認する。
     */
    public function testParseAllowedOriginsReturnsSingleOrigin(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://example.com');
        $this->assertSame(['https://example.com'], $result);
    }

    /**
     * カンマ区切りの複数オリジンが配列として正しくパースされることを確認する。
     */
    public function testParseAllowedOriginsReturnsMultipleOrigins(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://example.com,https://www.example.com');
        $this->assertSame(['https://example.com', 'https://www.example.com'], $result);
    }

    /**
     * カンマ前後の空白がトリムされることを確認する。
     */
    public function testParseAllowedOriginsTrimsWhitespace(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://example.com , https://www.example.com');
        $this->assertSame(['https://example.com', 'https://www.example.com'], $result);
    }

    // ─── isAllowedOrigin ─────────────────────────────────────────────────────

    /**
     * 許可リストに含まれるオリジンで true を返すことを確認する。
     */
    public function testIsAllowedOriginReturnsTrueForMatchingOrigin(): void
    {
        $this->assertTrue(
            UrlUtils::isAllowedOrigin('https://example.com', ['https://example.com']),
        );
    }

    /**
     * 許可リストに含まれないオリジンで false を返すことを確認する。
     */
    public function testIsAllowedOriginReturnsFalseForNonMatchingOrigin(): void
    {
        $this->assertFalse(
            UrlUtils::isAllowedOrigin('https://evil.com', ['https://example.com']),
        );
    }

    /**
     * ワイルドカード '*' が任意のオリジンを許可することを確認する。
     */
    public function testIsAllowedOriginReturnsTrueForWildcard(): void
    {
        $this->assertTrue(
            UrlUtils::isAllowedOrigin('https://any.thing', ['*']),
        );
    }

    // ─── findMatchedOrigin ───────────────────────────────────────────────────

    /**
     * マッチした場合に許可リスト側の文字列がそのまま返されることを確認する。
     */
    public function testFindMatchedOriginReturnsAllowedString(): void
    {
        // レスポンスには管理者が設定した文字列が返ること
        $result = UrlUtils::findMatchedOrigin(
            'https://example.com',
            ['https://example.com'],
        );
        $this->assertSame('https://example.com', $result);
    }

    /**
     * どのオリジンにもマッチしない場合に null を返すことを確認する。
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
     * ワイルドカードにマッチした場合にリテラル文字列 '*' が返されることを確認する。
     */
    public function testFindMatchedOriginReturnsWildcardLiteralString(): void
    {
        $result = UrlUtils::findMatchedOrigin('https://any.com', ['*']);
        $this->assertSame('*', $result);
    }

    /**
     * 不正な URL が渡された場合に null を返すことを確認する。
     */
    public function testFindMatchedOriginRejectsInvalidUrl(): void
    {
        $result = UrlUtils::findMatchedOrigin('not-a-url', ['https://example.com']);
        $this->assertNull($result);
    }

    /**
     * スキーム（http vs https）が異なる場合にマッチしないことを確認する。
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
     * ポート番号が異なる場合にマッチしないことを確認する。
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
     * 明示的なポート番号が一致する場合にマッチすることを確認する。
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
     * 空文字列を渡した場合に空配列が返されることを確認する。
     */
    public function testParseAllowedOriginsReturnsEmptyArrayForEmptyString(): void
    {
        $result = UrlUtils::parseAllowedOrigins('');
        $this->assertSame([], $result);
    }

    /**
     * 空白のみの文字列を渡した場合に空配列が返されることを確認する。
     */
    public function testParseAllowedOriginsReturnsEmptyArrayForWhitespaceOnly(): void
    {
        $result = UrlUtils::parseAllowedOrigins('   ');
        $this->assertSame([], $result);
    }

    /**
     * カンマ間の空エントリがフィルタされることを確認する。
     */
    public function testParseAllowedOriginsFiltersEmptyEntries(): void
    {
        $result = UrlUtils::parseAllowedOrigins('https://a.com,,https://b.com');
        $this->assertSame(['https://a.com', 'https://b.com'], $result);
    }

    // ─── findMatchedOrigin: malformed allowed origin ─────────────────────────

    /**
     * 許可リスト側に不正な URL が含まれていてもスキップして正常にマッチすることを確認する。
     */
    public function testFindMatchedOriginSkipsMalformedAllowedOrigin(): void
    {
        // 許可リスト側のオリジンが不正な URL でも他のエントリが評価される
        $result = UrlUtils::findMatchedOrigin(
            'https://example.com',
            ['not-valid', 'https://example.com'],
        );
        $this->assertSame('https://example.com', $result);
    }
}
