<?php

declare(strict_types=1);

/**
 * HTTP リクエストを表すイミュータブルな値オブジェクト。
 *
 * グローバル変数（$_SERVER, php://input）から生成するか、
 * テスト用に任意の値で生成できる。
 */
final readonly class Request
{
    /**
     * php://input の読み取り上限 (64KB + 1 byte)。
     *
     * 1 byte 多く読むことで上限超過を検出できる。
     */
    private const int MAX_BODY_READ = 65537;

    /**
     * @param string $method      HTTP メソッド（大文字正規化済み）
     * @param string $path        リクエストパス（スクリプトディレクトリ除去済み）
     * @param string $origin      Origin ヘッダーの値（空文字列 = 未送信）
     * @param string $contentType Content-Type のメディアタイプ部分（空文字列 = 未送信）
     * @param string $rawBody     リクエストボディの生データ
     */
    private function __construct(
        public string $method,
        public string $path,
        public string $origin,
        public string $contentType,
        private string $rawBody,
    ) {}

    /**
     * 実行環境のグローバル変数からリクエストを生成する。
     *
     * サブディレクトリ運用にも対応し、SCRIPT_NAME のディレクトリ部分を
     * REQUEST_URI から除去したパスを生成する。
     *
     * @return self 現在の HTTP リクエストを表すインスタンス
     */
    public static function fromGlobals(): self
    {
        $server = fn(string $key, string $default = ''): string
            => is_string($_SERVER[$key] ?? null) ? $_SERVER[$key] : $default;

        return new self(
            method: strtoupper($server('REQUEST_METHOD', 'GET')),
            path: self::resolvePath($server('SCRIPT_NAME', '/index.php'), $server('REQUEST_URI', '/')),
            origin: $server('HTTP_ORIGIN'),
            contentType: self::parseMediaType($server('CONTENT_TYPE')),
            rawBody: (string) (file_get_contents('php://input', false, null, 0, self::MAX_BODY_READ) ?: ''),
        );
    }

    /**
     * 任意の値からリクエストを生成する。
     *
     * 主にテストで使用する。
     *
     * @param string $method      HTTP メソッド（自動的に大文字に正規化される）
     * @param string $path        リクエストパス
     * @param string $origin      Origin ヘッダーの値
     * @param string $contentType Content-Type のメディアタイプ部分
     * @param string $body        リクエストボディ
     *
     * @return self 指定した値を持つインスタンス
     */
    public static function create(
        string $method,
        string $path,
        string $origin = '',
        string $contentType = '',
        string $body = '',
    ): self {
        return new self(strtoupper($method), $path, $origin, $contentType, $body);
    }

    /**
     * リクエストボディを返す。
     *
     * @param int $maxBytes ボディの最大許容バイト数
     *
     * @return string|false ボディ文字列。$maxBytes を超える場合は false
     */
    public function body(int $maxBytes): string|false
    {
        if (strlen($this->rawBody) > $maxBytes) {
            return false;
        }

        return $this->rawBody;
    }

    /**
     * サブディレクトリ配置を考慮したリクエストパスを解決する。
     *
     * SCRIPT_NAME のディレクトリ部（例: "/backend"）を REQUEST_URI から除去し、
     * ドキュメントルート直下でもサブディレクトリ配下でも同じパス比較を可能にする。
     */
    private static function resolvePath(string $scriptName, string $requestUri): string
    {
        $scriptDir  = rtrim(dirname($scriptName), '/');
        $parsedPath = parse_url($requestUri, PHP_URL_PATH);
        $fullPath   = is_string($parsedPath) ? $parsedPath : '/';

        if ($scriptDir !== '' && str_starts_with($fullPath, $scriptDir)) {
            $fullPath = substr($fullPath, strlen($scriptDir));
        }

        return $fullPath === '' ? '/' : $fullPath;
    }

    /**
     * Content-Type ヘッダーからメディアタイプ部分を抽出する。
     *
     * "application/json; charset=utf-8" → "application/json"
     */
    private static function parseMediaType(string $contentType): string
    {
        return strtolower(trim(explode(';', $contentType, 2)[0]));
    }
}
