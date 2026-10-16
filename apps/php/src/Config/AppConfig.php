<?php

declare(strict_types=1);

/**
 * An immutable value object that holds the application's settings.
 *
 * It reads the settings that SkyWay authentication needs from a .env file or an array of
 * environment variables, and creates a validated instance.
 */
final readonly class AppConfig
{
    /**
     * @param string   $appId          The SkyWay application id.
     * @param string   $secret         The SkyWay secret key.
     * @param int      $lobbySize      How many lobby channels there are at most.
     * @param string[] $allowedOrigins The list of origins that CORS allows.
     */
    public function __construct(
        public string $appId,
        public string $secret,
        public int    $lobbySize,
        public array  $allowedOrigins,
    ) {}

    /**
     * Reads a .env file and creates an instance from it.
     *
     * It looks through the candidate paths in order and uses the first .env it finds.
     * Setting the environment variable ENV_PATH puts any path ahead of all the others.
     *
     * @param string ...$candidates The candidate paths for the .env file (in order of preference).
     *
     * @return self The validated settings instance.
     *
     * @throws \InvalidArgumentException When no .env is found, or a required key is missing.
     */
    public static function load(string ...$candidates): self
    {
        $envPath = getenv('ENV_PATH');
        if ($envPath !== false && $envPath !== '') {
            array_unshift($candidates, $envPath);
        }

        foreach ($candidates as $path) {
            if (!file_exists($path)) {
                continue;
            }
            $result = parse_ini_file($path, false, INI_SCANNER_RAW);
            if ($result === false) {
                throw new \InvalidArgumentException(
                    "Failed to parse .env file: {$path}",
                );
            }

            return self::fromEnv($result);
        }

        throw new \InvalidArgumentException(
            'No .env file found. Searched: ' . implode(', ', $candidates),
        );
    }

    /**
     * Creates an instance from an array of environment variables.
     *
     * @param array<string, string> $env The environment variables, as pairs of key and value.
     *
     * @return self The validated settings instance.
     *
     * @throws \InvalidArgumentException When SKYWAY_APP_ID or SKYWAY_SECRET is not set.
     */
    public static function fromEnv(array $env): self
    {
        if (!isset($env['SKYWAY_APP_ID']) || $env['SKYWAY_APP_ID'] === '') {
            throw new \InvalidArgumentException('SKYWAY_APP_ID is required in .env');
        }

        if (!isset($env['SKYWAY_SECRET']) || $env['SKYWAY_SECRET'] === '') {
            throw new \InvalidArgumentException('SKYWAY_SECRET is required in .env');
        }

        return new self(
            appId: $env['SKYWAY_APP_ID'],
            secret: $env['SKYWAY_SECRET'],
            lobbySize: self::parseLobbySize($env['SKYWAY_UDONARIUM_LOBBY_SIZE'] ?? '3'),
            allowedOrigins: UrlUtils::parseAllowedOrigins($env['ACCESS_CONTROL_ALLOW_ORIGIN'] ?? ''),
        );
    }

    /**
     * Parses a lobby size string into a positive integer.
     *
     * @param string $value The string to parse.
     *
     * @return int An integer of 1 or more.
     *
     * @throws \InvalidArgumentException When the value is not a positive integer.
     */
    private static function parseLobbySize(string $value): int
    {
        $size = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($size === false) {
            throw new \InvalidArgumentException('SKYWAY_UDONARIUM_LOBBY_SIZE must be a positive integer');
        }

        return $size;
    }
}
