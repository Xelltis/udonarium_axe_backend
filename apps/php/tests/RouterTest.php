<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * {@see Router} のテストケース。
 *
 * メソッドチェーンによるルート登録、ミドルウェアのパスパターンマッチ、
 * notFound フォールバック、メソッド不一致時の 405 応答を検証する。
 */
class RouterTest extends TestCase
{
    // ─── ルートディスパッチ ──────────────────────────────────────────────────

    /**
     * 登録済みハンドラが正しくディスパッチされ、レスポンスを返すことを確認する。
     */
    public function testDispatchCallsRegisteredHandler(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, ['ok' => true]));

        $response = $router->dispatch('GET', '/foo');
        $this->assertSame(200, $response->statusCode);
    }

    /**
     * dispatch() のメソッド比較が大文字小文字を区別しないことを確認する。
     */
    public function testDispatchIsMethodCaseInsensitive(): void
    {
        $router = (new Router())
            ->post('/bar', fn(): Response => Response::json(201, []));

        $this->assertSame(201, $router->dispatch('post', '/bar')->statusCode);
        $this->assertSame(201, $router->dispatch('POST', '/bar')->statusCode);
    }

    /**
     * 未登録のパスに対してデフォルト 404 を返すことを確認する。
     */
    public function testDispatchReturnsDefault404ForUnknownPath(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, []));

        $this->assertSame(404, $router->dispatch('GET', '/unknown')->statusCode);
    }

    /**
     * パスは登録済みだがメソッドが異なる場合に 405 を返すことを確認する。
     */
    public function testDispatchReturns405ForWrongMethod(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, []));

        $this->assertSame(405, $router->dispatch('POST', '/foo')->statusCode);
    }

    /**
     * 405 レスポンスに Allow ヘッダーが含まれ、許可メソッドが列挙されることを確認する。
     */
    public function testDispatchReturnsAllowHeaderIn405(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, []))
            ->post('/foo', fn(): Response => Response::json(201, []));

        $response = $router->dispatch('DELETE', '/foo');
        $this->assertSame(405, $response->statusCode);
        $this->assertArrayHasKey('Allow', $response->headers);
        $this->assertStringContainsString('GET', $response->headers['Allow']);
        $this->assertStringContainsString('POST', $response->headers['Allow']);
    }

    // ─── notFound ────────────────────────────────────────────────────────────

    /**
     * notFound() で登録したハンドラが呼ばれることを確認する。
     */
    public function testNotFoundHandlerIsCalled(): void
    {
        $router = (new Router())
            ->notFound(fn(): Response => Response::text(404, 'Custom Not Found'));

        $response = $router->dispatch('GET', '/missing');
        $this->assertSame(404, $response->statusCode);
        $this->assertSame('Custom Not Found', $response->body);
    }

    // ─── ミドルウェア（use） ─────────────────────────────────────────────────

    /**
     * use() で登録したミドルウェアがプレフィックスマッチでハンドラをラップすることを確認する。
     */
    public function testUseAppliesMiddlewareToMatchingPrefix(): void
    {
        $mw = fn(\Closure $next): Response => $next()->withHeaders(['X-Test' => 'applied']);

        $router = (new Router())
            ->use('/api/*', $mw)
            ->get('/api/data', fn(): Response => Response::json(200, ['ok' => true]));

        $response = $router->dispatch('GET', '/api/data');
        $this->assertSame(200, $response->statusCode);
        $this->assertSame('applied', $response->headers['X-Test']);
    }

    /**
     * use() で登録したミドルウェアが 405 レスポンスもラップすることを確認する。
     */
    public function testUseAppliesMiddlewareTo405(): void
    {
        $mw = fn(\Closure $next): Response => $next()->withHeaders(['X-Test' => 'applied']);

        $router = (new Router())
            ->use('/api/*', $mw)
            ->post('/api/data', fn(): Response => Response::json(201, []));

        $response = $router->dispatch('GET', '/api/data');
        $this->assertSame(405, $response->statusCode);
        $this->assertSame('applied', $response->headers['X-Test']);
    }

    /**
     * パターンに一致しないパスにはミドルウェアが適用されないことを確認する。
     */
    public function testUseDoesNotApplyToNonMatchingPaths(): void
    {
        $mw = fn(\Closure $next): Response => $next()->withHeaders(['X-Test' => 'applied']);

        $router = (new Router())
            ->use('/api/*', $mw)
            ->get('/', fn(): Response => Response::text(200, 'home'));

        $response = $router->dispatch('GET', '/');
        $this->assertSame(200, $response->statusCode);
        $this->assertArrayNotHasKey('X-Test', $response->headers);
    }

    /**
     * ワイルドカード * が全パスにマッチすることを確認する。
     */
    public function testUseWildcardMatchesAllPaths(): void
    {
        $mw = fn(\Closure $next): Response => $next()->withHeaders(['X-Global' => '1']);

        $router = (new Router())
            ->use('*', $mw)
            ->get('/', fn(): Response => Response::text(200, 'home'))
            ->get('/foo', fn(): Response => Response::text(200, 'foo'));

        $this->assertSame('1', $router->dispatch('GET', '/')->headers['X-Global']);
        $this->assertSame('1', $router->dispatch('GET', '/foo')->headers['X-Global']);
    }

    /**
     * ミドルウェアがハンドラを呼ばずに短絡復帰できることを確認する。
     */
    public function testMiddlewareCanShortCircuit(): void
    {
        $mw = fn(\Closure $next): Response => Response::json(403, ['error' => 'Forbidden']);

        $router = (new Router())
            ->use('/secret/*', $mw)
            ->get('/secret/data', fn(): Response => Response::json(200, ['data' => 'top-secret']));

        $this->assertSame(403, $router->dispatch('GET', '/secret/data')->statusCode);
    }

    /**
     * use() で完全一致パターンがマッチすることを確認する。
     */
    public function testUseExactPathMatch(): void
    {
        $mw = fn(\Closure $next): Response => $next()->withHeaders(['X-Exact' => '1']);

        $router = (new Router())
            ->use('/only-this', $mw)
            ->get('/only-this', fn(): Response => Response::text(200, 'hit'))
            ->get('/other', fn(): Response => Response::text(200, 'miss'));

        $this->assertSame('1', $router->dispatch('GET', '/only-this')->headers['X-Exact']);
        $this->assertArrayNotHasKey('X-Exact', $router->dispatch('GET', '/other')->headers);
    }
}
