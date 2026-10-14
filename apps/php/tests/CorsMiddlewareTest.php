<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see CorsMiddleware} のテストケース。
 *
 * Origin 検証、プリフライト処理、CORS ヘッダー付与、
 * 設定読み込みエラー時の振る舞いを検証する。
 */
class CorsMiddlewareTest extends TestCase
{
    /** @var \Closure(): Response 何もしないダミーハンドラ */
    private \Closure $dummyNext;

    protected function setUp(): void
    {
        $this->dummyNext = fn(): Response => Response::json(200, ['ok' => true]);
    }

    /**
     * テスト用 AppConfig を生成する。
     *
     * @param list<string> $origins 許可オリジン
     */
    private static function config(array $origins = ['https://example.com']): AppConfig
    {
        return AppConfig::fromEnv([
            'SKYWAY_APP_ID'                => 'test-app',
            'SKYWAY_SECRET'                => 'test-secret',
            'SKYWAY_UDONARIUM_LOBBY_SIZE'  => '3',
            'ACCESS_CONTROL_ALLOW_ORIGIN'  => implode(',', $origins),
        ]);
    }


    // ─── Origin 検証 ─────────────────────────────────────────────────────────

    /**
     * Origin ヘッダー未送信で 400 を返すことを確認する。
     */
    public function testReturns400WhenOriginMissing(): void
    {
        $cors = new CorsMiddleware(Request::create('POST', '/api'), self::config());

        $this->assertSame(400, $cors($this->dummyNext)->statusCode);
    }

    /**
     * 許可されていないオリジンで 403 を返すことを確認する。
     */
    public function testReturns403WhenOriginForbidden(): void
    {
        $cors = new CorsMiddleware(
            Request::create('POST', '/api', origin: 'https://evil.com'),
            self::config(),
        );

        $this->assertSame(403, $cors($this->dummyNext)->statusCode);
    }

    // ─── プリフライト ────────────────────────────────────────────────────────

    /**
     * OPTIONS リクエストが 204 と CORS ヘッダーを返すことを確認する。
     */
    public function testPreflightReturns204WithCorsHeaders(): void
    {
        $cors = new CorsMiddleware(
            Request::create('OPTIONS', '/api', origin: 'https://example.com'),
            self::config(),
        );

        $response = $cors($this->dummyNext);
        $this->assertSame(204, $response->statusCode);
        $this->assertSame('https://example.com', $response->headers['Access-Control-Allow-Origin']);
        $this->assertSame('GET, POST, OPTIONS', $response->headers['Access-Control-Allow-Methods']);
        $this->assertSame('Content-Type, Accept', $response->headers['Access-Control-Allow-Headers']);
        $this->assertSame('86400', $response->headers['Access-Control-Max-Age']);
        $this->assertSame('Origin', $response->headers['Vary']);
    }

    // ─── 正常系 ──────────────────────────────────────────────────────────────

    /**
     * 正常リクエストでハンドラのレスポンスに CORS ヘッダーが付与されることを確認する。
     */
    public function testAddsCorsHeadersToHandlerResponse(): void
    {
        $cors = new CorsMiddleware(
            Request::create('POST', '/api', origin: 'https://example.com'),
            self::config(),
        );

        $response = $cors($this->dummyNext);
        $this->assertSame(200, $response->statusCode);
        $this->assertSame('https://example.com', $response->headers['Access-Control-Allow-Origin']);
        $this->assertSame('Origin', $response->headers['Vary']);
    }
}
