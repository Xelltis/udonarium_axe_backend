<?php

declare(strict_types=1);

/**
 * An immutable value object that stands for an HTTP response.
 *
 * The factory methods create JSON, text and 204 responses,
 * and {@see send()} actually sends them out.
 */
final readonly class Response
{
    /**
     * @param int                  $statusCode  The HTTP status code.
     * @param string               $contentType The Content-Type header value (empty to leave it out).
     * @param string               $body        The response body.
     * @param array<string, string> $headers     Extra response headers.
     */
    private function __construct(
        public int    $statusCode,
        private string $contentType,
        public string $body,
        public array  $headers = [],
    ) {}

    /**
     * Creates a JSON response.
     *
     * @param int   $code The HTTP status code.
     * @param mixed $data The data to encode as JSON.
     *
     * @return self A response with Content-Type: application/json.
     *
     * @throws \JsonException When encoding fails.
     */
    public static function json(int $code, mixed $data): self
    {
        return new self(
            statusCode: $code,
            contentType: 'application/json',
            body: (string) json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
        );
    }

    /**
     * Creates a plain text response.
     *
     * @param int    $code The HTTP status code.
     * @param string $body The response body.
     *
     * @return self A response with Content-Type: text/plain.
     */
    public static function text(int $code, string $body): self
    {
        return new self(
            statusCode: $code,
            contentType: 'text/plain',
            body: $body,
        );
    }

    /**
     * Creates a 204 No Content response.
     *
     * @return self A 204 response with no body and no Content-Type.
     */
    public static function noContent(): self
    {
        return new self(statusCode: 204, contentType: '', body: '');
    }

    /**
     * Returns a new instance with extra headers merged in.
     *
     * @param array<string, string> $extra The extra headers to merge.
     *
     * @return self A new instance with the headers added.
     */
    public function withHeaders(array $extra): self
    {
        return new self($this->statusCode, $this->contentType, $this->body, array_merge($this->headers, $extra));
    }

    /**
     * Sends the response.
     *
     * It sends the status code, Content-Type, the security headers and the extra headers,
     * then writes out the body.
     *
     * @codeCoverageIgnore
     */
    public function send(): void
    {
        http_response_code($this->statusCode);
        if ($this->contentType !== '') {
            header('Content-Type: ' . $this->contentType);
        }

        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');

        foreach ($this->headers as $name => $value) {
            header($name . ': ' . $value);
        }

        echo $this->body;
    }
}
