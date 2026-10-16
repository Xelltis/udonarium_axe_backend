<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see Request}.
 *
 * They test both creating one by hand with the factory method create(),
 * and creating one from the globals with fromGlobals().
 */
class RequestTest extends TestCase
{
    /** @var array<string, mixed> The state of $_SERVER, put aside in setUp. */
    private array $savedServer;

    /**
     * Puts $_SERVER aside before each test.
     */
    protected function setUp(): void
    {
        $this->savedServer = $_SERVER;
    }

    /**
     * Puts $_SERVER back after each test, so it leaves no side effects.
     */
    protected function tearDown(): void
    {
        $_SERVER = $this->savedServer;
    }

    // ─── create() ────────────────────────────────────────────────────────────

    /**
     * Checks that the method of a request created with create() is turned into upper case.
     */
    public function testCreateSetsMethodUppercased(): void
    {
        $req = Request::create('get', '/foo');
        $this->assertSame('GET', $req->method);
    }

    /**
     * Checks that the path given to create() is set as it is.
     */
    public function testCreateSetsPath(): void
    {
        $req = Request::create('POST', '/v1/test');
        $this->assertSame('/v1/test', $req->path);
    }

    /**
     * Checks that the origin given to create() is set as it is.
     */
    public function testCreateSetsOrigin(): void
    {
        $req = Request::create('GET', '/', 'https://example.com');
        $this->assertSame('https://example.com', $req->origin);
    }

    /**
     * Checks that the origin defaults to an empty string when create() is not given one.
     */
    public function testCreateDefaultsOriginToEmptyString(): void
    {
        $req = Request::create('GET', '/');
        $this->assertSame('', $req->origin);
    }

    /**
     * Checks that the contentType given to create() is set as it is.
     */
    public function testCreateSetsContentType(): void
    {
        $req = Request::create('POST', '/', '', 'application/json');
        $this->assertSame('application/json', $req->contentType);
    }

    /**
     * Checks that contentType defaults to an empty string when create() is not given one.
     */
    public function testCreateDefaultsContentTypeToEmptyString(): void
    {
        $req = Request::create('GET', '/');
        $this->assertSame('', $req->contentType);
    }

    /**
     * Checks that body() returns the body as it is when it is within the size limit.
     */
    public function testBodyReturnsBodyWhenUnderLimit(): void
    {
        $body = '{"foo":"bar"}';
        $req  = Request::create('POST', '/', '', '', $body);
        $this->assertSame($body, $req->body(65536));
    }

    /**
     * Checks that body() returns false when the body is over the size limit.
     */
    public function testBodyReturnsFalseWhenOverLimit(): void
    {
        $body = str_repeat('x', 65537);
        $req  = Request::create('POST', '/', '', '', $body);
        $this->assertFalse($req->body(65536));
    }

    /**
     * Checks that body() returns the body when it is exactly at the size limit.
     */
    public function testBodyReturnsBodyAtExactLimit(): void
    {
        $body = str_repeat('x', 65536);
        $req  = Request::create('POST', '/', '', '', $body);
        $this->assertSame($body, $req->body(65536));
    }

    // ─── fromGlobals() ───────────────────────────────────────────────────────

    /**
     * Checks that fromGlobals() reads the method, path and origin from $_SERVER correctly.
     */
    public function testFromGlobalsReadsMethodPathAndOrigin(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'POST';
        $_SERVER['REQUEST_URI']    = '/v1/test';
        $_SERVER['SCRIPT_NAME']    = '/index.php';
        $_SERVER['HTTP_ORIGIN']    = 'https://example.com';

        $req = Request::fromGlobals();
        $this->assertSame('POST', $req->method);
        $this->assertSame('/v1/test', $req->path);
        $this->assertSame('https://example.com', $req->origin);
    }

    /**
     * Checks that the subdirectory prefix from SCRIPT_NAME is taken off REQUEST_URI.
     */
    public function testFromGlobalsStripsSubdirectoryPrefix(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['REQUEST_URI']    = '/backend/v1/status';
        $_SERVER['SCRIPT_NAME']    = '/backend/index.php';

        $req = Request::fromGlobals();
        $this->assertSame('/v1/status', $req->path);
    }

    /**
     * Checks that a path left empty once the prefix is taken off is normalized to '/'.
     */
    public function testFromGlobalsEmptyPathAfterStripBecomesSlash(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['REQUEST_URI']    = '/backend';
        $_SERVER['SCRIPT_NAME']    = '/backend/index.php';

        $req = Request::fromGlobals();
        $this->assertSame('/', $req->path);
    }

    /**
     * Checks that the path stays as it is when REQUEST_URI does not match SCRIPT_NAME's directory.
     */
    public function testFromGlobalsDoesNotStripWhenPathDoesNotMatchScriptDir(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['REQUEST_URI']    = '/other/path';
        $_SERVER['SCRIPT_NAME']    = '/backend/index.php';

        $req = Request::fromGlobals();
        $this->assertSame('/other/path', $req->path);
    }

    /**
     * Checks that the method defaults to 'GET' when REQUEST_METHOD is not set.
     */
    public function testFromGlobalsDefaultsMethodToGetWhenMissing(): void
    {
        unset($_SERVER['REQUEST_METHOD']);
        $_SERVER['REQUEST_URI'] = '/';
        $_SERVER['SCRIPT_NAME'] = '/index.php';

        $req = Request::fromGlobals();
        $this->assertSame('GET', $req->method);
    }

    /**
     * Checks that origin is an empty string when HTTP_ORIGIN is not set.
     */
    public function testFromGlobalsDefaultsOriginToEmptyWhenMissing(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['REQUEST_URI']    = '/';
        $_SERVER['SCRIPT_NAME']    = '/index.php';
        unset($_SERVER['HTTP_ORIGIN']);

        $req = Request::fromGlobals();
        $this->assertSame('', $req->origin);
    }

    /**
     * Checks that fromGlobals() also turns the method into upper case.
     */
    public function testFromGlobalsUppercasesMethod(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'options';
        $_SERVER['REQUEST_URI']    = '/';
        $_SERVER['SCRIPT_NAME']    = '/index.php';

        $req = Request::fromGlobals();
        $this->assertSame('OPTIONS', $req->method);
    }

    /**
     * Checks that fromGlobals() takes the media type part out of CONTENT_TYPE.
     */
    public function testFromGlobalsExtractsContentType(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'POST';
        $_SERVER['REQUEST_URI']    = '/';
        $_SERVER['SCRIPT_NAME']    = '/index.php';
        $_SERVER['CONTENT_TYPE']   = 'application/json; charset=utf-8';

        $req = Request::fromGlobals();
        $this->assertSame('application/json', $req->contentType);
    }

    /**
     * Checks that contentType is an empty string when CONTENT_TYPE is not set.
     */
    public function testFromGlobalsDefaultsContentTypeToEmptyWhenMissing(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $_SERVER['REQUEST_URI']    = '/';
        $_SERVER['SCRIPT_NAME']    = '/index.php';
        unset($_SERVER['CONTENT_TYPE']);

        $req = Request::fromGlobals();
        $this->assertSame('', $req->contentType);
    }
}
