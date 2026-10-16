<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see Response}.
 *
 * They test the factory methods for JSON, text and 204, the immutable handling of headers,
 * the return type of send(), and the exception for a value that cannot be encoded as JSON.
 */
class ResponseTest extends TestCase
{
    /**
     * Checks that json() sets the status code and the JSON body correctly.
     */
    public function testJsonSetsStatusCodeAndBody(): void
    {
        $response = Response::json(200, ['key' => 'value']);
        $this->assertSame(200, $response->statusCode);
        $this->assertSame('{"key":"value"}', $response->body);
    }

    /**
     * Checks that json() writes Unicode characters out as they are, without escaping them.
     */
    public function testJsonEncodesUnicodeWithoutEscape(): void
    {
        $response = Response::json(200, ['msg' => 'こんにちは']);
        $this->assertStringContainsString('こんにちは', $response->body);
    }

    /**
     * Checks that text() sets the status code and the plain text body correctly.
     */
    public function testTextSetsStatusCodeAndBody(): void
    {
        $response = Response::text(200, 'OK');
        $this->assertSame(200, $response->statusCode);
        $this->assertSame('OK', $response->body);
    }

    /**
     * Checks that noContent() returns a 204 status and an empty body.
     */
    public function testNoContentReturns204WithEmptyBody(): void
    {
        $response = Response::noContent();
        $this->assertSame(204, $response->statusCode);
        $this->assertSame('', $response->body);
    }

    /**
     * Checks that the headers given to withHeaders() are merged into the response.
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
     * Checks that withHeaders() is immutable and leaves the original instance unchanged.
     */
    public function testWithHeadersIsImmutable(): void
    {
        $original = Response::json(200, []);
        $updated  = $original->withHeaders(['X-New' => 'value']);

        $this->assertEmpty($original->headers);
        $this->assertArrayHasKey('X-New', $updated->headers);
    }

    /**
     * Checks that calling withHeaders() twice in a row lets the later value overwrite the same key.
     */
    public function testWithHeadersOverridesExistingKey(): void
    {
        $response = Response::json(200, [])
            ->withHeaders(['X-Foo' => 'first'])
            ->withHeaders(['X-Foo' => 'second']);

        $this->assertSame('second', $response->headers['X-Foo']);
    }

    /**
     * Checks through reflection that the return type of the send() method is void.
     */
    public function testSendMethodIsVoidReturnType(): void
    {
        $method     = new \ReflectionMethod(Response::class, 'send');
        $returnType = $method->getReturnType();

        $this->assertNotNull($returnType);
        $this->assertSame('void', (string) $returnType);
    }

    /**
     * Checks that json() throws a JsonException when given a value it cannot encode as JSON (NAN).
     */
    public function testJsonThrowsOnUnencodableValue(): void
    {
        $this->expectException(\JsonException::class);
        Response::json(200, NAN);
    }
}
