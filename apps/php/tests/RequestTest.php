<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see Request} のテストケース。
 *
 * ファクトリメソッド create() による手動生成と、
 * fromGlobals() によるグローバル変数からの生成の両方を検証する。
 */
class RequestTest extends TestCase
{
    /** @var array<string, mixed> setUp 時に退避した $_SERVER の状態 */
    private array $savedServer;

    /**
     * テスト前に $_SERVER を退避する。
     */
    protected function setUp(): void
    {
        $this->savedServer = $_SERVER;
    }

    /**
     * テスト後に $_SERVER を復元して副作用を防ぐ。
     */
    protected function tearDown(): void
    {
        $_SERVER = $this->savedServer;
    }

    // ─── create() ────────────────────────────────────────────────────────────

    /**
     * create() で生成したリクエストの method が大文字化されることを確認する。
     */
    public function testCreateSetsMethodUppercased(): void
    {
        $req = Request::create('get', '/foo');
        $this->assertSame('GET', $req->method);
    }

    /**
     * create() で指定したパスがそのまま設定されることを確認する。
     */
    public function testCreateSetsPath(): void
    {
        $req = Request::create('POST', '/v1/test');
        $this->assertSame('/v1/test', $req->path);
    }

    /**
     * create() で指定したオリジンがそのまま設定されることを確認する。
     */
    public function testCreateSetsOrigin(): void
    {
        $req = Request::create('GET', '/', 'https://example.com');
        $this->assertSame('https://example.com', $req->origin);
    }

    /**
     * create() でオリジンを省略した場合、空文字列がデフォルトになることを確認する。
     */
    public function testCreateDefaultsOriginToEmptyString(): void
    {
        $req = Request::create('GET', '/');
        $this->assertSame('', $req->origin);
    }

    /**
     * create() で指定した contentType がそのまま設定されることを確認する。
     */
    public function testCreateSetsContentType(): void
    {
        $req = Request::create('POST', '/', '', 'application/json');
        $this->assertSame('application/json', $req->contentType);
    }

    /**
     * create() で contentType を省略した場合、空文字列がデフォルトになることを確認する。
     */
    public function testCreateDefaultsContentTypeToEmptyString(): void
    {
        $req = Request::create('GET', '/');
        $this->assertSame('', $req->contentType);
    }

    /**
     * body() がサイズ上限以内のとき、ボディ文字列をそのまま返すことを確認する。
     */
    public function testBodyReturnsBodyWhenUnderLimit(): void
    {
        $body = '{"foo":"bar"}';
        $req  = Request::create('POST', '/', '', '', $body);
        $this->assertSame($body, $req->body(65536));
    }

    /**
     * body() がサイズ上限を超えるとき、false を返すことを確認する。
     */
    public function testBodyReturnsFalseWhenOverLimit(): void
    {
        $body = str_repeat('x', 65537);
        $req  = Request::create('POST', '/', '', '', $body);
        $this->assertFalse($req->body(65536));
    }

    /**
     * body() がちょうどサイズ上限のとき、ボディ文字列を返すことを確認する。
     */
    public function testBodyReturnsBodyAtExactLimit(): void
    {
        $body = str_repeat('x', 65536);
        $req  = Request::create('POST', '/', '', '', $body);
        $this->assertSame($body, $req->body(65536));
    }

    // ─── fromGlobals() ───────────────────────────────────────────────────────

    /**
     * fromGlobals() が $_SERVER からメソッド・パス・オリジンを正しく読み取ることを確認する。
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
     * SCRIPT_NAME のサブディレクトリプレフィックスが REQUEST_URI から除去されることを確認する。
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
     * プレフィックス除去後にパスが空になる場合、'/' に正規化されることを確認する。
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
     * REQUEST_URI が SCRIPT_NAME のディレクトリと一致しない場合、パスがそのまま残ることを確認する。
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
     * REQUEST_METHOD が未設定の場合、デフォルトで 'GET' になることを確認する。
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
     * HTTP_ORIGIN が未設定の場合、origin が空文字列になることを確認する。
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
     * fromGlobals() でも method が大文字化されることを確認する。
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
     * fromGlobals() が CONTENT_TYPE からメディアタイプ部分を抽出することを確認する。
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
     * CONTENT_TYPE が未設定の場合、contentType が空文字列になることを確認する。
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
