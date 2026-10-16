<?php

declare(strict_types=1);

/**
 * An HTTP router with method chaining, in the style of Hono.
 *
 * Routes are registered with {@see get()} / {@see post()}, middleware for a path pattern with
 * {@see use()} and the fallback handler with {@see notFound()}, all declaratively, and
 * {@see dispatch()} runs the handler that matches the request.
 */
final class Router
{
    /** @var array<string, array<string, \Closure(): Response>> Path → method → handler. */
    private array $routes = [];

    /** @var list<array{pattern: string, middleware: \Closure(\Closure(): Response): Response}> */
    private array $middlewareStack = [];

    /** @var ?\Closure(): Response */
    private ?\Closure $notFoundHandler = null;

    /**
     * Registers a GET route.
     *
     * @param \Closure(): Response $handler The handler.
     */
    public function get(string $path, \Closure $handler): self
    {
        return $this->addRoute('GET', $path, $handler);
    }

    /**
     * Registers a POST route.
     *
     * @param \Closure(): Response $handler The handler.
     */
    public function post(string $path, \Closure $handler): self
    {
        return $this->addRoute('POST', $path, $handler);
    }

    /**
     * Registers middleware for a path pattern.
     *
     * A pattern that ends in /* matches by prefix,
     * * matches every path, and any other pattern must match exactly.
     * Middleware runs in the order it is registered (what is registered first is on the outside).
     *
     * @param \Closure(\Closure(): Response): Response $middleware The middleware.
     */
    public function use(string $pattern, \Closure $middleware): self
    {
        $this->middlewareStack[] = ['pattern' => $pattern, 'middleware' => $middleware];

        return $this;
    }

    /**
     * Registers the fallback handler for when the path is not registered.
     *
     * @param \Closure(): Response $handler The handler.
     */
    public function notFound(\Closure $handler): self
    {
        $this->notFoundHandler = $handler;

        return $this;
    }

    /**
     * Dispatches a request and returns the response.
     *
     * For a path not registered, it returns the notFound handler's response or the default 404.
     * When the path is there but the method is not registered, it returns 405.
     * Middleware whose path pattern matches is applied to both the handler and the 405.
     *
     * @param string $method The HTTP method (case does not matter).
     * @param string $path   The request path.
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
