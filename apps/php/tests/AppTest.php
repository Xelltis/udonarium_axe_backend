<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * {@see App} のテストケース。
 *
 * パブリックルート、CORS 検証、トークン発行エンドポイントを含む
 * リクエスト→レスポンスのパイプライン全体を検証する。
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

    // ─── パブリックルート ────────────────────────────────────────────────────

    /**
     * GET / がウェルカム JSON を返すことを確認する。
     */
    public function testRootEndpointReturnsWelcomeJson(): void
    {
        $response = (new App($this->envDir))->handle(Request::create('GET', '/'));

        $this->assertSame(200, $response->statusCode);
        $this->assertStringContainsString('Ready to serve your realm.', $response->body);
    }

    /**
     * GET /v1/status が "OK" を返すことを確認する。
     */
    public function testStatusEndpointReturnsOk(): void
    {
        $response = (new App($this->envDir))->handle(Request::create('GET', '/v1/status'));

        $this->assertSame(200, $response->statusCode);
        $this->assertSame('OK', $response->body);
    }

    /**
     * パブリックルートに未登録のメソッドで 405 を返すことを確認する。
     */
    public function testPublicRouteReturnsMethodNotAllowed(): void
    {
        $response = (new App($this->envDir))->handle(Request::create('POST', '/'));

        $this->assertSame(405, $response->statusCode);
    }

    // ─── 設定エラー ──────────────────────────────────────────────────────────

    /**
     * .env が見つからない場合にコンストラクタで例外を投げることを確認する。
     */
    public function testMissingConfigThrowsException(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        new App('/nonexistent/dir');
    }

    // ─── Origin 検証 ─────────────────────────────────────────────────────────

    /**
     * Origin ヘッダー未送信で 400 を返すことを確認する。
     */
    public function testMissingOriginReturns400(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('POST', '/v1/skyway2023/token'),
        );

        $this->assertSame(400, $response->statusCode);
    }

    /**
     * 許可されていないオリジンで 403 を返すことを確認する。
     */
    public function testForbiddenOriginReturns403(): void
    {
        $response = (new App($this->envDir))->handle(
            Request::create('POST', '/v1/skyway2023/token', origin: 'https://evil.com'),
        );

        $this->assertSame(403, $response->statusCode);
    }

    // ─── CORS プリフライト ───────────────────────────────────────────────────

    /**
     * OPTIONS リクエストが 204 と CORS ヘッダーを返すことを確認する。
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

    // ─── ルーティング ────────────────────────────────────────────────────────

    /**
     * 未登録パスが 404 を CORS ヘッダー付きで返すことを確認する。
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
     * API ルートに未登録のメソッドで 405 を CORS ヘッダー付きで返すことを確認する。
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

    // ─── トークンエンドポイント ──────────────────────────────────────────────

    /**
     * 正常なリクエストでトークンを含む 200 を返すことを確認する。
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
     * レスポンスに CORS ヘッダーが付与されていることを確認する。
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
     * Content-Type が application/json でない場合に 415 を返すことを確認する。
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
     * ボディが 64KB を超える場合に 413 を返すことを確認する。
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
     * 不正な JSON で 400 を返すことを確認する。
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
     * 必須フィールドが欠けている場合に 400 を返すことを確認する。
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
     * formatVersion が不正な場合に 400 を返すことを確認する。
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
     * channelName が上限 (200文字) を超える場合に 400 を返すことを確認する。
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
     * スコープ名にワイルドカード等が含まれる場合に 400 を返すことを確認する。
     *
     * SkyWay はスコープ内の name で "*" をワイルドカードとして解釈するため、
     * これを許すとトークンの権限が全チャンネル・全メンバーに拡大する。
     *
     * @param string $channelName リクエストの channelName
     * @param string $peerId      リクエストの peerId
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
     * @return array<string, array{string, string}> ケース名 => [channelName, peerId]
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
