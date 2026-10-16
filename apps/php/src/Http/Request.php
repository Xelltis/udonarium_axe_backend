<?php

declare(strict_types=1);

/**
 * An immutable value object that stands for an HTTP request.
 *
 * It can be created from the globals ($_SERVER, php://input),
 * or from any values for tests.
 */
final readonly class Request
{
    /**
     * The limit on how much of php://input is read (64KB + 1 byte).
     *
     * Reading 1 byte more shows when the body is over the limit.
     */
    private const int MAX_BODY_READ = 65537;

    /**
     * @param string $method      The HTTP method (already normalized to upper case).
     * @param string $path        The request path (with the script directory already taken off).
     * @param string $origin      The value of the Origin header (empty when not sent).
     * @param string $contentType The media type part of Content-Type (empty when not sent).
     * @param string $rawBody     The raw request body.
     */
    private function __construct(
        public string $method,
        public string $path,
        public string $origin,
        public string $contentType,
        private string $rawBody,
    ) {}

    /**
     * Creates a request from the globals of the environment it runs in.
     *
     * It also works when the app runs in a subdirectory: the path is REQUEST_URI with the
     * directory part of SCRIPT_NAME taken off.
     *
     * @return self An instance for the current HTTP request.
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
     * Creates a request from any values.
     *
     * It is used mostly in tests.
     *
     * @param string $method      The HTTP method (normalized to upper case automatically).
     * @param string $path        The request path.
     * @param string $origin      The value of the Origin header.
     * @param string $contentType The media type part of Content-Type.
     * @param string $body        The request body.
     *
     * @return self An instance with the given values.
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
     * Returns the request body.
     *
     * @param int $maxBytes The most bytes the body may have.
     *
     * @return string|false The body string, or false when it is over $maxBytes.
     */
    public function body(int $maxBytes): string|false
    {
        if (strlen($this->rawBody) > $maxBytes) {
            return false;
        }

        return $this->rawBody;
    }

    /**
     * Works out the request path, allowing for the app being placed in a subdirectory.
     *
     * It takes the directory part of SCRIPT_NAME (for example "/backend") off REQUEST_URI, so that
     * paths compare the same way right under the document root and in a subdirectory.
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
     * Takes the media type part out of a Content-Type header.
     *
     * "application/json; charset=utf-8" → "application/json"
     */
    private static function parseMediaType(string $contentType): string
    {
        return strtolower(trim(explode(';', $contentType, 2)[0]));
    }
}
