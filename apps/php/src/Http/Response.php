<?php

declare(strict_types=1);

/**
 * HTTP レスポンスを表すイミュータブルな値オブジェクト。
 *
 * ファクトリメソッドで JSON・テキスト・204 のレスポンスを生成し、
 * {@see send()} で実際に送出する。
 */
final readonly class Response
{
    /**
     * @param int                  $statusCode  HTTP ステータスコード
     * @param string               $contentType Content-Type ヘッダー値（空文字列 = 省略）
     * @param string               $body        レスポンスボディ
     * @param array<string, string> $headers     追加レスポンスヘッダー
     */
    private function __construct(
        public int    $statusCode,
        private string $contentType,
        public string $body,
        public array  $headers = [],
    ) {}

    /**
     * JSON レスポンスを生成する。
     *
     * @param int   $code HTTP ステータスコード
     * @param mixed $data JSON エンコード対象のデータ
     *
     * @return self Content-Type: application/json のレスポンス
     *
     * @throws \JsonException エンコードに失敗した場合
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
     * プレーンテキストレスポンスを生成する。
     *
     * @param int    $code HTTP ステータスコード
     * @param string $body レスポンスボディ
     *
     * @return self Content-Type: text/plain のレスポンス
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
     * 204 No Content レスポンスを生成する。
     *
     * @return self ボディ・Content-Type のない 204 レスポンス
     */
    public static function noContent(): self
    {
        return new self(statusCode: 204, contentType: '', body: '');
    }

    /**
     * 追加ヘッダーをマージした新しいインスタンスを返す。
     *
     * @param array<string, string> $extra マージする追加ヘッダー
     *
     * @return self ヘッダーが追加された新しいインスタンス
     */
    public function withHeaders(array $extra): self
    {
        return new self($this->statusCode, $this->contentType, $this->body, array_merge($this->headers, $extra));
    }

    /**
     * レスポンスを送出する。
     *
     * ステータスコード・Content-Type・セキュリティヘッダー・追加ヘッダーを
     * 送出し、ボディを出力する。
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
