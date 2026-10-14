<?php

declare(strict_types=1);

/**
 * Hono ライクなメソッドチェーン HTTP ルーター。
 *
 * {@see get()} / {@see post()} でルートを、{@see use()} でパスパターン付きミドルウェアを、
 * {@see notFound()} でフォールバックハンドラを宣言的に登録し、
 * {@see dispatch()} でリクエストに一致するハンドラを実行する。
 */
final class Router
{
    /** @var array<string, array<string, \Closure(): Response>> パス → メソッド → ハンドラ */
    private array $routes = [];

    /** @var list<array{pattern: string, middleware: \Closure(\Closure(): Response): Response}> */
    private array $middlewareStack = [];

    /** @var ?\Closure(): Response */
    private ?\Closure $notFoundHandler = null;

    /**
     * GET ルートを登録する。
     *
     * @param \Closure(): Response $handler ハンドラ
     */
    public function get(string $path, \Closure $handler): self
    {
        return $this->addRoute('GET', $path, $handler);
    }

    /**
     * POST ルートを登録する。
     *
     * @param \Closure(): Response $handler ハンドラ
     */
    public function post(string $path, \Closure $handler): self
    {
        return $this->addRoute('POST', $path, $handler);
    }

    /**
     * パスパターンにミドルウェアを登録する。
     *
     * パターン末尾が /* の場合はプレフィックスマッチ、
     * * は全パスマッチ、それ以外は完全一致。
     * 登録順がそのまま実行順となる（先に登録したものが外側）。
     *
     * @param \Closure(\Closure(): Response): Response $middleware ミドルウェア
     */
    public function use(string $pattern, \Closure $middleware): self
    {
        $this->middlewareStack[] = ['pattern' => $pattern, 'middleware' => $middleware];

        return $this;
    }

    /**
     * パスが未登録の場合のフォールバックハンドラを登録する。
     *
     * @param \Closure(): Response $handler ハンドラ
     */
    public function notFound(\Closure $handler): self
    {
        $this->notFoundHandler = $handler;

        return $this;
    }

    /**
     * リクエストをディスパッチしてレスポンスを返す。
     *
     * パスが未登録なら notFound ハンドラまたはデフォルト 404 を返す。
     * パスは存在するがメソッドが未登録なら 405 を返す。
     * パスパターンに一致するミドルウェアがあれば、ハンドラ・405 の両方に適用する。
     *
     * @param string $method HTTP メソッド（大文字・小文字は問わない）
     * @param string $path   リクエストパス
     */
    public function dispatch(string $method, string $path): Response
    {
        if (!isset($this->routes[$path])) {
            return $this->notFoundHandler !== null
                ? ($this->notFoundHandler)()
                : Response::json(404, ['error' => 'Not Found.']);
        }

        $method = strtoupper($method);

        if (isset($this->routes[$path][$method])) {
            $handler = $this->routes[$path][$method];
        } else {
            $allowed = implode(', ', array_keys($this->routes[$path]));
            $handler = static fn(): Response => Response::text(405, 'Method Not Allowed')
                ->withHeaders(['Allow' => $allowed]);
        }

        foreach (array_reverse($this->middlewareStack) as $entry) {
            if (self::matchesPattern($entry['pattern'], $path)) {
                $next = $handler;
                $mw   = $entry['middleware'];
                $handler = static fn(): Response => $mw($next);
            }
        }

        return $handler();
    }

    private function addRoute(string $method, string $path, \Closure $handler): self
    {
        $this->routes[$path][strtoupper($method)] = $handler;

        return $this;
    }

    private static function matchesPattern(string $pattern, string $path): bool
    {
        if ($pattern === '*') {
            return true;
        }

        if (str_ends_with($pattern, '/*')) {
            return str_starts_with($path, substr($pattern, 0, -1));
        }

        return $pattern === $path;
    }
}
