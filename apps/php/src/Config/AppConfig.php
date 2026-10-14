<?php

declare(strict_types=1);

/**
 * アプリケーション設定を保持するイミュータブルな値オブジェクト。
 *
 * .env ファイルまたは環境変数配列から SkyWay 認証に必要な設定値を読み込み、
 * バリデーション済みのインスタンスを生成する。
 */
final readonly class AppConfig
{
    /**
     * @param string   $appId          SkyWay アプリケーション ID
     * @param string   $secret         SkyWay シークレットキー
     * @param int      $lobbySize      ロビーチャンネルの最大数
     * @param string[] $allowedOrigins CORS で許可するオリジンのリスト
     */
    public function __construct(
        public string $appId,
        public string $secret,
        public int    $lobbySize,
        public array  $allowedOrigins,
    ) {}

    /**
     * .env ファイルを読み込んでインスタンスを生成する。
     *
     * 候補パスを先頭から順に探し、最初に見つかった .env を使用する。
     * 環境変数 ENV_PATH を設定すると任意のパスを最優先で使用できる。
     *
     * @param string ...$candidates .env ファイルの候補パス（優先順）
     *
     * @return self バリデーション済みの設定インスタンス
     *
     * @throws \InvalidArgumentException .env が見つからない場合、または必須キーが欠けている場合
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
     * 環境変数配列からインスタンスを生成する。
     *
     * @param array<string, string> $env キーと値のペアからなる環境変数配列
     *
     * @return self バリデーション済みの設定インスタンス
     *
     * @throws \InvalidArgumentException SKYWAY_APP_ID または SKYWAY_SECRET が未設定の場合
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
     * ロビーサイズ文字列を正の整数にパースする。
     *
     * @param string $value パース対象の文字列
     *
     * @return int 1 以上の整数
     *
     * @throws \InvalidArgumentException 値が正の整数でない場合
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
