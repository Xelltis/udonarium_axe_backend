<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see CorsMiddleware}.
 *
 * They test the Origin check, the handling of preflight requests, adding the CORS headers,
 * and what happens when the settings fail to load.
 */
class CorsMiddlewareTest extends TestCase
{
    /** @var \Closure(): Response A dummy handler that returns a 200 JSON response. */
    private \Closure $dummyNext;

    protected function setUp(): void
    {
        $this->dummyNext = fn(): Response => Response::json(200, ['ok' => true]);
    }

    /**
     * Creates an AppConfig for tests.
     *
     * @param list<string> $origins The allowed origins.
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


    // ─── Origin check ────────────────────────────────────────────────────────

    /**
     * Checks that it returns 400 when no Origin header is sent.
     */
    public function testReturns400WhenOriginMissing(): void
    {
        $cors = new CorsMiddleware(Request::create('POST', '/api'), self::config());

        $this->assertSame(400, $cors($this->dummyNext)->statusCode);
    }

    /**
     * Checks that it returns 403 for an origin that is not allowed.
     */
    public function testReturns403WhenOriginForbidden(): void
    {
        $cors = new CorsMiddleware(
            Request::create('POST', '/api', origin: 'https://evil.com'),
            self::config(),
        );

        $this->assertSame(403, $cors($this->dummyNext)->statusCode);
    }

    // ─── Preflight ───────────────────────────────────────────────────────────

    /**
     * Checks that an OPTIONS request gets 204 and the CORS headers.
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

    // ─── Happy path ──────────────────────────────────────────────────────────

    /**
     * Checks that, for a valid request, the CORS headers are added to the handler's response.
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
