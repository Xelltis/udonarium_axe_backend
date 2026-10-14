<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * index.php の結合テスト。
 *
 * PHP ビルトインサーバーで index.php を起動し、
 * 実際の HTTP リクエストを送ってレスポンスを検証する。
 */
class IndexTest extends TestCase
{
    private string $envDir;

    private string $envFile;

    /** @var resource|false|null */
    private $serverProcess;

    private string $baseUrl;

    protected function setUp(): void
    {
        $this->envDir  = sys_get_temp_dir() . '/index-test-' . uniqid();
        mkdir($this->envDir);
        $this->envFile = $this->envDir . '/.env';
        file_put_contents($this->envFile, implode("\n", [
            'SKYWAY_APP_ID=test-app',
            'SKYWAY_SECRET=test-secret',
            'SKYWAY_UDONARIUM_LOBBY_SIZE=3',
            'ACCESS_CONTROL_ALLOW_ORIGIN=https://example.com',
        ]));

        // index.php のコピーを作成（baseDir をテスト用ディレクトリに差し替え）
        $projectRoot = dirname(__DIR__);
        $entrypoint  = $this->envDir . '/index.php';
        file_put_contents($entrypoint, strtr(
            (string) file_get_contents($projectRoot . '/index.php'),
            ['__DIR__' => var_export($this->envDir, true)],
        ));

        // src/ へのシンボリックリンクを作成
        symlink($projectRoot . '/src', $this->envDir . '/src');

        $port           = $this->findAvailablePort();
        $this->baseUrl  = "http://127.0.0.1:{$port}";

        $this->serverProcess = proc_open(
            [PHP_BINARY, '-S', "127.0.0.1:{$port}", '-t', $this->envDir],
            [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']],
            $pipes,
        );

        // サーバー起動待ち
        $this->waitForServer($port);
    }

    protected function tearDown(): void
    {
        if (\is_resource($this->serverProcess)) {
            proc_terminate($this->serverProcess);
            proc_close($this->serverProcess);
        }

        $this->cleanup($this->envDir);
    }

    // ─── テストケース ────────────────────────────────────────────────────────

    /**
     * GET / がウェルカム JSON を返すことを確認する。
     */
    public function testRootEndpointReturnsWelcomeJson(): void
    {
        $response = $this->httpGet('/');

        $this->assertSame(200, $response['status']);
        $this->assertStringContainsString('application/json', $response['contentType']);
        $this->assertStringContainsString('Ready to serve your realm.', $response['body']);
    }

    /**
     * GET /v1/status が "OK" を返すことを確認する。
     */
    public function testStatusEndpointReturnsOk(): void
    {
        $response = $this->httpGet('/v1/status');

        $this->assertSame(200, $response['status']);
        $this->assertSame('OK', $response['body']);
    }

    /**
     * 未登録パスが 404 を返すことを確認する。
     */
    public function testNotFoundReturns404(): void
    {
        $response = $this->httpGet('/nonexistent', ['Origin: https://example.com']);

        $this->assertSame(404, $response['status']);
    }

    /**
     * POST /v1/skyway2023/token が正常にトークンを返すことを確認する。
     */
    public function testTokenEndpointReturnsToken(): void
    {
        $body = json_encode([
            'formatVersion' => 1,
            'channelName'   => 'test-channel',
            'peerId'        => 'test-peer',
        ], JSON_THROW_ON_ERROR);

        $response = $this->httpPost('/v1/skyway2023/token', $body, [
            'Content-Type: application/json',
            'Origin: https://example.com',
        ]);

        $this->assertSame(200, $response['status']);
        $decoded = json_decode($response['body'], true);
        $this->assertIsArray($decoded);
        $this->assertArrayHasKey('token', $decoded);
    }

    // ─── ヘルパー ────────────────────────────────────────────────────────────

    private function findAvailablePort(): int
    {
        $server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        $this->assertNotFalse($server, "Failed to create socket: {$errstr}");
        $name = stream_socket_get_name($server, false);
        $this->assertNotFalse($name);
        fclose($server);

        return (int) substr($name, (int) strrpos($name, ':') + 1);
    }

    private function waitForServer(int $port, float $timeout = 5.0): void
    {
        $deadline = microtime(true) + $timeout;
        while (microtime(true) < $deadline) {
            $connection = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.1);
            if ($connection !== false) {
                fclose($connection);

                return;
            }
            usleep(50_000);
        }
        $this->fail("PHP built-in server did not start within {$timeout}s");
    }

    /**
     * @param list<string> $headers
     *
     * @return array{status: int, contentType: string, body: string}
     */
    private function httpGet(string $path, array $headers = []): array
    {
        return $this->request('GET', $path, null, $headers);
    }

    /**
     * @param list<string> $headers
     *
     * @return array{status: int, contentType: string, body: string}
     */
    private function httpPost(string $path, string $body, array $headers = []): array
    {
        return $this->request('POST', $path, $body, $headers);
    }

    /**
     * @param list<string> $headers
     *
     * @return array{status: int, contentType: string, body: string}
     */
    private function request(string $method, string $path, ?string $body, array $headers): array
    {
        $context = stream_context_create(['http' => [
            'method'        => $method,
            'header'        => implode("\r\n", $headers),
            'content'       => $body,
            'ignore_errors' => true,
            'timeout'       => 5,
        ]]);

        $responseBody = file_get_contents($this->baseUrl . $path, false, $context);

        /** @var list<string> $http_response_header */
        $this->assertNotEmpty($http_response_header);

        $status      = $this->parseStatusCode($http_response_header);
        $contentType = $this->parseHeader($http_response_header, 'Content-Type');

        return [
            'status'      => $status,
            'contentType' => $contentType,
            'body'        => (string) $responseBody,
        ];
    }

    /**
     * @param list<string> $headers
     */
    private function parseStatusCode(array $headers): int
    {
        $this->assertArrayHasKey(0, $headers);
        preg_match('/\d{3}/', $headers[0], $matches);

        return (int) ($matches[0] ?? 0);
    }

    /**
     * @param list<string> $headers
     */
    private function parseHeader(array $headers, string $name): string
    {
        foreach ($headers as $header) {
            if (stripos($header, $name . ':') === 0) {
                return trim(substr($header, strlen($name) + 1));
            }
        }

        return '';
    }

    private function cleanup(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . '/' . $item;
            if (is_link($path)) {
                unlink($path);
            } elseif (is_dir($path)) {
                $this->cleanup($path);
            } else {
                unlink($path);
            }
        }
        rmdir($dir);
    }
}
