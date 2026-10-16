<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see App}.
 *
 * They test the whole pipeline from request to response, including the public routes,
 * the CORS check and the endpoint that issues tokens.
 */
class AppTest extends TestCase
{
    private string $envDir;

    private string $envFile;

    protected function setUp(): void
    {
        $this->envDir  = sys_get_temp_dir() . '/app-test-' . uniqid();
        mkdir($this->envDir);
        $this->envFile = $this->envDir . '/.env';
        file_put_contents($this->envFile, implode("\n", [
            'SKYWAY_APP_ID=test-app',
            'SKYWAY_SECRET=test-secret',
            'SKYWAY_UDONARIUM_LOBBY_SIZE=3',
            'ACCESS_CONTROL_ALLOW_ORIGIN=https://example.com',
        ]));
    }

    protected function tearDown(): void
    {
        if (file_exists($this->envFile)) {
            unlink($this->envFile);
        }
        if (is_dir($this->envDir)) {
            rmdir($this->envDir);
        }
    }

    // ─── Public routes ───────────────────────────────────────────────────────

    /**
     * Checks that GET / returns the welcome JSON.
     */
    public function testRootEndpointReturnsWelcomeJson(): void
    {
        $response = (new App($this->envDir))->handle(Request::create('GET', '/'));

        $this->assertSame(200, $response->statusCode);
        $this->assertStringContainsString('Ready to serve your realm.', $response->body);
    }

    /**
     * Checks that GET /v1/status returns "OK".
     */
    public function testStatusEndpointReturnsOk(): void
    {
        $response = (new App($this->envDir))->handle(Request::create('GET', '/v1/status'));

        $this->assertSame(200, $response->statusCode);
        $this->assertSame('OK', $response->body);
    }

    /**
     * Checks that a public route returns 405 for a method not registered on it.
     */
    public function testPublicRouteReturnsMethodNotAllowed(): void
    {
        $response = (new App($this->envDir))->handle(Request::create('POST', '/'));

        $this->assertSame(405, $response->statusCode);
    }

    // ─── Config errors ───────────────────────────────────────────────────────

    /**
     * Checks that the constructor throws an exception when no .env is found.
     */
    public function testMissingConfigThrowsException(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        new App('/nonexistent/dir');
    }

    // ─── Origin check ────────────────────────────────────────────────────────

    /**
     * Checks that it returns 400 when no Origin header is sent.
     */
    public function testMissingOriginReturns400(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('POST', '/v1/skyway2023/token'),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * Checks that it returns 403 for an origin that is not allowed.
     */
    public function testForbiddenOriginReturns403(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('POST', '/v1/skyway2023/token', origin: 'https://evil.com'),
        );

        $this->assertSame(403, $response->statusCode);
    }

    // ─── CORS preflight ──────────────────────────────────────────────────────

    /**
     * Checks that an OPTIONS request gets 204 and the CORS headers.
     */
    public function testPreflightReturnsNoContentWithCorsHeaders(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('OPTIONS', '/v1/skyway2023/token', origin: 'https://example.com'),
        );

        $this->assertSame(204, $response->statusCode);
        $this->assertSame('https://example.com', $response->headers['Access-Control-Allow-Origin']);
        $this->assertSame('Origin', $response->headers['Vary']);
    }

    // ─── Routing ─────────────────────────────────────────────────────────────

    /**
     * Checks that a path not registered returns 404 with the CORS headers.
     */
    public function testNotFoundIncludesCorsHeaders(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('GET', '/nonexistent', origin: 'https://example.com'),
        );

        $this->assertSame(404, $response->statusCode);
        $this->assertSame('https://example.com', $response->headers['Access-Control-Allow-Origin']);
    }

    /**
     * Checks that an API route returns 405 with the CORS headers for a method not registered on it.
     */
    public function testApiRouteMethodNotAllowedIncludesCorsHeaders(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('GET', '/v1/skyway2023/token', origin: 'https://example.com'),
        );

        $this->assertSame(405, $response->statusCode);
        $this->assertSame('POST', $response->headers['Allow']);
        $this->assertArrayHasKey('Access-Control-Allow-Origin', $response->headers);
    }

    // ─── Token endpoint ──────────────────────────────────────────────────────

    /**
     * Checks that a valid request gets 200 with a token.
     */
    public function testTokenEndpointReturnsToken(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: json_encode([
                    'formatVersion' => 1,
                    'channelName'   => 'test-channel',
                    'peerId'        => 'test-peer',
                ], JSON_THROW_ON_ERROR),
            ),
        );

        $this->assertSame(200, $response->statusCode);
        $decoded = json_decode($response->body, true);
        $this->assertIsArray($decoded);
        $this->assertArrayHasKey('token', $decoded);
    }

    /**
     * Checks that the response has the CORS headers added.
     */
    public function testTokenResponseIncludesCorsHeaders(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: json_encode([
                    'formatVersion' => 1,
                    'channelName'   => 'ch',
                    'peerId'        => 'p',
                ], JSON_THROW_ON_ERROR),
            ),
        );

        $this->assertSame('https://example.com', $response->headers['Access-Control-Allow-Origin']);
        $this->assertSame('Origin', $response->headers['Vary']);
    }

    /**
     * Checks that it returns 415 when Content-Type is not application/json.
     */
    public function testTokenEndpointRejectsWrongContentType(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'text/plain',
                body: '{}',
            ),
        );

        $this->assertSame(415, $response->statusCode);
    }

    /**
     * Checks that it returns 413 when the body is over 64KB.
     */
    public function testTokenEndpointRejectsOversizedBody(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: str_repeat('x', 65537),
            ),
        );

        $this->assertSame(413, $response->statusCode);
    }

    /**
     * Checks that it returns 400 for invalid JSON.
     */
    public function testTokenEndpointRejectsInvalidJson(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: 'not-json',
            ),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * Checks that it returns 400 when a required field is missing.
     */
    public function testTokenEndpointRejectsMissingFields(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: json_encode(['formatVersion' => 1], JSON_THROW_ON_ERROR),
            ),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * Checks that it returns 400 when formatVersion is wrong.
     */
    public function testTokenEndpointRejectsWrongFormatVersion(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: json_encode([
                    'formatVersion' => 999,
                    'channelName'   => 'ch',
                    'peerId'        => 'p',
                ], JSON_THROW_ON_ERROR),
            ),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * Checks that it returns 400 when channelName is over the limit (200 bytes, as strlen counts them).
     */
    public function testTokenEndpointRejectsOversizedChannelName(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: json_encode([
                    'formatVersion' => 1,
                    'channelName'   => str_repeat('a', 201),
                    'peerId'        => 'p',
                ], JSON_THROW_ON_ERROR),
            ),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * Checks that it returns 400 when a scope name has a wildcard or the like in it.
     *
     * SkyWay reads "*" in a name in a scope as a wildcard, so letting it through
     * would widen the token's permissions to every channel and every member.
     *
     * @param string $channelName The request's channelName.
     * @param string $peerId      The request's peerId.
     */
    #[DataProvider('unsafeScopeNameProvider')]
    public function testTokenEndpointRejectsUnsafeScopeNames(string $channelName, string $peerId): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create(
                'POST',
                '/v1/skyway2023/token',
                origin: 'https://example.com',
                contentType: 'application/json',
                body: json_encode([
                    'formatVersion' => 1,
                    'channelName'   => $channelName,
                    'peerId'        => $peerId,
                ], JSON_THROW_ON_ERROR),
            ),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * @return array<string, array{string, string}> Case name => [channelName, peerId].
     */
    public static function unsafeScopeNameProvider(): array
    {
        return [
            'channelName がワイルドカードそのもの' => ['*', 'p'],
            'channelName が前方一致ワイルドカード' => ['room-*', 'p'],
            'channelName がエスケープ文字を含む'   => ['room-\\*', 'p'],
            'channelName が空文字列'               => ['', 'p'],
            'peerId がワイルドカードそのもの'      => ['ch', '*'],
            'peerId が前方一致ワイルドカード'      => ['ch', 'peer-*'],
            'peerId が空文字列'                    => ['ch', ''],
            'channelName がロビーの予約名'         => ['udonarium-lobby-1-of-3', 'p'],
            'channelName がロビーの予約プレフィックス' => ['udonarium-lobby-anything', 'p'],
        ];
    }
}
