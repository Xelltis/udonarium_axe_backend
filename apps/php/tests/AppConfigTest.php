<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see AppConfig}.
 *
 * They test both creating an instance from an array of environment variables (fromEnv)
 * and loading one from a .env file (load).
 */
class AppConfigTest extends TestCase
{
    /** @var string The path of the temporary directory for the tests. */
    private string $tempDir;

    /**
     * Creates a temporary directory for the test.
     */
    protected function setUp(): void
    {
        $this->tempDir = sys_get_temp_dir() . '/appconfig_test_' . uniqid();
        mkdir($this->tempDir);
    }

    /**
     * Deletes the files in the temporary directory, then the directory itself.
     *
     * It also resets the ENV_PATH environment variable, so that other tests are not affected.
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
     * Returns a valid array of environment variables for tests.
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
     * Checks that valid environment variables create a correct instance.
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
     * Checks that the default of 3 is used when SKYWAY_UDONARIUM_LOBBY_SIZE is not set.
     */
    public function testFromEnvDefaultsLobbySizeTo3(): void
    {
        $env = $this->validEnv();
        unset($env['SKYWAY_UDONARIUM_LOBBY_SIZE']);
        $config = AppConfig::fromEnv($env);
        $this->assertSame(3, $config->lobbySize);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when SKYWAY_APP_ID is missing.
     */
    public function testFromEnvThrowsWhenAppIdMissing(): void
    {
        $env = $this->validEnv();
        unset($env['SKYWAY_APP_ID']);
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when SKYWAY_SECRET is missing.
     */
    public function testFromEnvThrowsWhenSecretMissing(): void
    {
        $env = $this->validEnv();
        unset($env['SKYWAY_SECRET']);
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * Checks that several comma-separated origins are parsed correctly.
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
     * Checks that an InvalidArgumentException is thrown when the lobby size is 0.
     */
    public function testFromEnvThrowsWhenLobbySizeIsZero(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '0';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when the lobby size is negative.
     */
    public function testFromEnvThrowsWhenLobbySizeIsNegative(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '-1';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when the lobby size is a non-numeric string.
     */
    public function testFromEnvThrowsWhenLobbySizeIsNonNumeric(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = 'abc';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when the lobby size starts with a digit
     * but has other characters in it.
     */
    public function testFromEnvThrowsWhenLobbySizeHasTrailingNonNumeric(): void
    {
        $env                              = $this->validEnv();
        $env['SKYWAY_UDONARIUM_LOBBY_SIZE'] = '3abc';
        $this->expectException(\InvalidArgumentException::class);
        AppConfig::fromEnv($env);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when the lobby size is a decimal.
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
     * Checks that an InvalidArgumentException is thrown when none of the candidate files exist.
     */
    public function testLoadThrowsWhenNoFileFound(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('No .env file found');
        AppConfig::load('/nonexistent/path/.env');
    }

    /**
     * Checks that a valid .env file creates a correct instance.
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
     * Checks that the first file found is used when there are several candidates.
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
     * Checks that a candidate file that does not exist is skipped and the next candidate is read.
     */
    public function testLoadSkipsNonExistentCandidates(): void
    {
        $envFile = $this->tempDir . '/.env';
        file_put_contents($envFile, "SKYWAY_APP_ID=my-app\nSKYWAY_SECRET=my-secret\n");

        $config = AppConfig::load('/nonexistent/.env', $envFile);
        $this->assertSame('my-app', $config->appId);
    }

    /**
     * Checks that the ENV_PATH environment variable, when set, comes before the candidate files.
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
     * Checks that a string value in the .env file is converted to the right type (lobbySize → int).
     */
    public function testLoadPreservesStringValuesWithoutTypeConversion(): void
    {
        $envFile = $this->tempDir . '/.env';
        file_put_contents($envFile, "SKYWAY_APP_ID=app\nSKYWAY_SECRET=secret\nSKYWAY_UDONARIUM_LOBBY_SIZE=5\n");

        $config = AppConfig::load($envFile);
        $this->assertSame(5, $config->lobbySize);
    }

    /**
     * Checks that an InvalidArgumentException is thrown when the .env file cannot be parsed.
     */
    #[\PHPUnit\Framework\Attributes\WithoutErrorHandler]
    public function testLoadThrowsWhenEnvFileCannotBeParsed(): void
    {
        $envFile = $this->tempDir . '/.env';
        // Bad syntax that makes parse_ini_file return false (a section that is never closed).
        file_put_contents($envFile, "[invalid\nKEY=value\n");

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Failed to parse .env file');
        @AppConfig::load($envFile);
    }
}
