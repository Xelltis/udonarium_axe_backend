<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see AppConfig} のテストケース。
 *
 * 環境変数配列からのインスタンス生成（fromEnv）と
 * .env ファイルからのロード（load）の両方を検証する。
 */
class AppConfigTest extends TestCase
{
    /** @var string テスト用一時ディレクトリのパス */
    private string $tempDir;

    /**
     * テスト用の一時ディレクトリを作成する。
     */
    protected function setUp(): void
    {
        $this->tempDir = sys_get_temp_dir() . '/appconfig_test_' . uniqid();
        mkdir($this->tempDir);
    }

    /**
     * 一時ディレクトリ内のファイルを削除し、ディレクトリを破棄する。
     *
     * ENV_PATH 環境変数もリセットして他のテストへの影響を防ぐ。
     */
    protected function tearDown(): void
    {
        foreach (new DirectoryIterator($this->tempDir) as $item) {
            if (!$item->isDot() && $item->isFile()) {
                unlink($item->getPathname());
            }
        }
        rmdir($this->tempDir);
        putenv('ENV_PATH'); // unset
    }

    // ──────────────────────────────────────────────
    // fromEnv
    // ──────────────────────────────────────────────

    /**
     * テスト用の有効な環境変数配列を返す。
     *
     * @return array<string, string>
     */
    private function validEnv(): array
    {
        return [
            'SKYWAY_APP_ID'               => 'app-id',
            'SKYWAY_SECRET'               => 'secret',
            'SKYWAY_UDONARIUM_LOBBY_SIZE' => '4',
            'ACCESS_CONTROL_ALLOW_ORIGIN' => 'https://example.com',
        ];
    }

    /**
     * 有効な環境変数からインスタンスが正しく生成されることを確認する。
     */
    public function testFromEnvCreatesInstance(): void
    {
        $config = AppConfig::fromEnv($this->validEnv());
        $this->assertSame('app-id', $config->appId);
        $this->assertSame('secret', $config->secret);
        $this->assertSame(4, $config->lobbySize);
        $this->assertSame(['https://example.com'], $config->allowedOrigins);
    }

    /**
     * SKYWAY_UDONARIUM_LOBBY_SIZE が未設定の場合、デフォルト値 3 が適用されることを確認する。
     */
    public function testFromEnvDefaultsLobbySizeTo3(): void
    {
        $env = $this->validEnv();
        unset($env['SKYWAY_UDONARIUM_LOBBY_SIZE']);
        $config = AppConfig::fromEnv($env);
        $this->assertSame(3, $config->lobbySize);
    }

    /**
     * SKYWAY_APP_ID が欠落している場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenAppIdMissing(): void
    {
        $env = $this->validEnv();
        unset($env['SKYWAY_APP_ID']);
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * SKYWAY_SECRET が欠落している場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenSecretMissing(): void
    {
        $env = $this->validEnv();
        unset($env['SKYWAY_SECRET']);
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * カンマ区切りの複数オリジンが正しくパースされることを確認する。
     */
    public function testFromEnvParsesMultipleOrigins(): void
    {
        $env                              = $this->validEnv();
        $env['ACCESS_CONTROL_ALLOW_ORIGIN'] = 'https://a.com, https://b.com';
        $config = AppConfig::fromEnv($env);
        $this->assertContains('https://a.com', $config->allowedOrigins);
        $this->assertContains('https://b.com', $config->allowedOrigins);
    }

    /**
     * ロビーサイズが 0 の場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenLobbySizeIsZero(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '0';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * ロビーサイズが負の値の場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenLobbySizeIsNegative(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '-1';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * ロビーサイズが数値以外の文字列の場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenLobbySizeIsNonNumeric(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = 'abc';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * ロビーサイズが数字で始まるが数値以外の文字を含む場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenLobbySizeHasTrailingNonNumeric(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '3abc';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * ロビーサイズが小数の場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testFromEnvThrowsWhenLobbySizeIsFloat(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '3.5';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    // ──────────────────────────────────────────────
    // load
    // ──────────────────────────────────────────────

    /**
     * 候補ファイルがすべて存在しない場合に InvalidArgumentException がスローされることを確認する。
     */
    public function testLoadThrowsWhenNoFileFound(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('No .env file found');
        AppConfig::load('/nonexistent/path/.env');
    }

    /**
     * 有効な .env ファイルからインスタンスが正しく生成されることを確認する。
     */
    public function testLoadParsesValidEnvFile(): void
    {
        $envFile = $this->tempDir . '/.env';
        file_put_contents($envFile, "SKYWAY_APP_ID=my-app\nSKYWAY_SECRET=my-secret\n");

        $config = AppConfig::load($envFile);
        $this->assertSame('my-app', $config->appId);
        $this->assertSame('my-secret', $config->secret);
    }

    /**
     * 複数の候補が存在する場合、最初に見つかったファイルが使用されることを確認する。
     */
    public function testLoadUsesFirstFoundCandidate(): void
    {
        $first  = $this->tempDir . '/first.env';
        $second = $this->tempDir . '/second.env';
        file_put_contents($first, "SKYWAY_APP_ID=first-app\nSKYWAY_SECRET=first-secret\n");
        file_put_contents($second, "SKYWAY_APP_ID=second-app\nSKYWAY_SECRET=second-secret\n");

        $config = AppConfig::load($first, $second);
        $this->assertSame('first-app', $config->appId);
    }

    /**
     * 存在しない候補ファイルをスキップして次の候補を読み込むことを確認する。
     */
    public function testLoadSkipsNonExistentCandidates(): void
    {
        $envFile = $this->tempDir . '/.env';
        file_put_contents($envFile, "SKYWAY_APP_ID=my-app\nSKYWAY_SECRET=my-secret\n");

        $config = AppConfig::load('/nonexistent/.env', $envFile);
        $this->assertSame('my-app', $config->appId);
    }

    /**
     * ENV_PATH 環境変数が設定されている場合、候補ファイルより優先されることを確認する。
     */
    public function testLoadEnvPathTakesPriorityOverCandidates(): void
    {
        $priority = $this->tempDir . '/priority.env';
        $fallback = $this->tempDir . '/fallback.env';
        file_put_contents($priority, "SKYWAY_APP_ID=priority-app\nSKYWAY_SECRET=priority-secret\n");
        file_put_contents($fallback, "SKYWAY_APP_ID=fallback-app\nSKYWAY_SECRET=fallback-secret\n");

        putenv("ENV_PATH={$priority}");

        $config = AppConfig::load($fallback);
        $this->assertSame('priority-app', $config->appId);
    }

    /**
     * .env ファイルの文字列値が正しく型変換（lobbySize → int）されることを確認する。
     */
    public function testLoadPreservesStringValuesWithoutTypeConversion(): void
    {
        $envFile = $this->tempDir . '/.env';
        file_put_contents($envFile, "SKYWAY_APP_ID=app\nSKYWAY_SECRET=secret\nSKYWAY_UDONARIUM_LOBBY_SIZE=5\n");

        $config = AppConfig::load($envFile);
        $this->assertSame(5, $config->lobbySize);
    }

    /**
     * .env ファイルのパースに失敗した場合に InvalidArgumentException がスローされることを確認する。
     */
    #[\PHPUnit\Framework\Attributes\WithoutErrorHandler]
    public function testLoadThrowsWhenEnvFileCannotBeParsed(): void
    {
        $envFile = $this->tempDir . '/.env';
        // parse_ini_file が false を返す不正な構文（閉じられていないセクション）
        file_put_contents($envFile, "[invalid\nKEY=value\n");

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Failed to parse .env file');
        @AppConfig::load($envFile);
    }
}
