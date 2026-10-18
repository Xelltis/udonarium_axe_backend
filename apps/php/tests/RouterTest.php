<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Test cases for {@see Router}.
 *
 * They test registering routes by method chaining, matching middleware by path pattern,
 * the notFound fallback, and the 405 answer when the method does not match.
 */
class RouterTest extends TestCase
{
    // ─── Route dispatch ──────────────────────────────────────────────────────

    /**
     * Checks that a registered handler is dispatched correctly and returns its response.
     */
    public function testDispatchCallsRegisteredHandler(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, ['ok' => true]));

        $response = $router->dispatch('GET', '/foo');
        $this->assertSame(200, $response->statusCode);
    }

    /**
     * Checks that dispatch() compares methods without regard to case.
     */
    public function testDispatchIsMethodCaseInsensitive(): void
    {
        $router = (new Router())
            ->post('/bar', fn(): Response => Response::json(201, []));

        $this->assertSame(201, $router->dispatch('post', '/bar')->statusCode);
        $this->assertSame(201, $router->dispatch('POST', '/bar')->statusCode);
    }

    /**
     * Checks that it returns the default 404 for a path not registered.
     */
    public function testDispatchReturnsDefault404ForUnknownPath(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, []));

        $this->assertSame(404, $router->dispatch('GET', '/unknown')->statusCode);
    }

    /**
     * Checks that it returns 405 when the path is registered but the method is different.
     */
    public function testDispatchReturns405ForWrongMethod(): void
    {
        $router = (new Router())
            ->get('/foo', fn(): Response => Response::json(200, []));

        $this->assertSame(405, $router->dispatch('POST', '/foo')->statusCode);
    }

    /**
     * Checks that a 405 response has an Allow header that lists the allowed methods.
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
     * Checks that the handler registered with notFound() is called.
     */
    public function testNotFoundHandlerIsCalled(): void
    {
        $router = (new Router())
            ->notFound(fn(): Response => Response::text(404, 'Custom Not Found'));

        $response = $router->dispatch('GET', '/missing');
        $this->assertSame(404, $response->statusCode);
        $this->assertSame('Custom Not Found', $response->body);
    }

    // ─── Middleware (use) ────────────────────────────────────────────────────

    /**
     * Checks that middleware registered with use() wraps the handler when the prefix matches.
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
     * Checks that middleware registered with use() wraps a 405 response too.
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
     * Checks that middleware is not applied to paths that do not match its pattern.
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
     * Checks that the wildcard * matches every path.
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
     * Checks that middleware can short-circuit and return without calling the handler.
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
     * Checks that an exact pattern given to use() matches.
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
