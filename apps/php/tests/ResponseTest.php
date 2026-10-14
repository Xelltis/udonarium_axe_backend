<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see Response} のテストケース。
 *
 * JSON・テキスト・204 の各ファクトリメソッド、ヘッダーのイミュータブル操作、
 * send() の戻り値型、および JSON エンコード不能値の例外を検証する。
 */
class ResponseTest extends TestCase
{
    /**
     * json() がステータスコードと JSON ボディを正しく設定することを確認する。
     */
    public function testJsonSetsStatusCodeAndBody(): void
    {
        $response = Response::json(200, ['key' => 'value']);
        $this->assertSame(200, $response->statusCode);
        $this->assertSame('{"key":"value"}', $response->body);
    }

    /**
     * json() が Unicode 文字をエスケープせずにそのまま出力することを確認する。
     */
    public function testJsonEncodesUnicodeWithoutEscape(): void
    {
        $response = Response::json(200, ['msg' => 'こんにちは']);
        $this->assertStringContainsString('こんにちは', $response->body);
    }

    /**
     * text() がステータスコードとプレーンテキストボディを正しく設定することを確認する。
     */
    public function testTextSetsStatusCodeAndBody(): void
    {
        $response = Response::text(200, 'OK');
        $this->assertSame(200, $response->statusCode);
        $this->assertSame('OK', $response->body);
    }

    /**
     * noContent() が 204 ステータスと空ボディを返すことを確認する。
     */
    public function testNoContentReturns204WithEmptyBody(): void
    {
        $response = Response::noContent();
        $this->assertSame(204, $response->statusCode);
        $this->assertSame('', $response->body);
    }

    /**
     * withHeaders() で指定したヘッダーがレスポンスにマージされることを確認する。
     */
    public function testWithHeadersMergesHeaders(): void
    {
        $response = Response::json(200, [])
            ->withHeaders(['X-Foo' => 'bar', 'X-Baz' => 'qux']);

        $headers = $response->headers;
        $this->assertSame('bar', $headers['X-Foo']);
        $this->assertSame('qux', $headers['X-Baz']);
    }

    /**
     * withHeaders() がイミュータブルで、元のインスタンスを変更しないことを確認する。
     */
    public function testWithHeadersIsImmutable(): void
    {
        $original = Response::json(200, []);
        $updated  = $original->withHeaders(['X-New' => 'value']);

        $this->assertEmpty($original->headers);
        $this->assertArrayHasKey('X-New', $updated->headers);
    }

    /**
     * withHeaders() を連続で呼ぶと後の値が同名キーを上書きすることを確認する。
     */
    public function testWithHeadersOverridesExistingKey(): void
    {
        $response = Response::json(200, [])
            ->withHeaders(['X-Foo' => 'first'])
            ->withHeaders(['X-Foo' => 'second']);

        $this->assertSame('second', $response->headers['X-Foo']);
    }

    /**
     * send() メソッドの戻り値型が void であることをリフレクションで確認する。
     */
    public function testSendMethodIsVoidReturnType(): void
    {
        $method     = new \ReflectionMethod(Response::class, 'send');
        $returnType = $method->getReturnType();

        $this->assertNotNull($returnType);
        $this->assertSame('void', (string) $returnType);
    }

    /**
     * json() に JSON エンコード不能な値（NAN）を渡すと JsonException がスローされることを確認する。
     */
    public function testJsonThrowsOnUnencodableValue(): void
    {
        $this->expectException(\JsonException::class);
        Response::json(200, NAN);
    }
}
