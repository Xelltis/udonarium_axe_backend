<?php

declare(strict_types=1);

require_once __DIR__ . '/../Config/AppConfig.php';
require_once __DIR__ . '/../Http/Request.php';
require_once __DIR__ . '/../Http/Response.php';
require_once __DIR__ . '/../Util/UrlUtils.php';

/**
 * The CORS middleware.
 *
 * It checks the Origin, answers preflight requests and adds the CORS headers, all in one place.
 * When the check fails, it returns an error response without calling the handler.
 */
final readonly class CorsMiddleware
{
    public function __construct(
        private Request    $request,
        private AppConfig  $config,
    ) {}

    /**
     * Wraps a handler, as middleware.
     *
     * @param \Closure(): Response $next The next handler.
     */
    public function __invoke(\Closure $next): Response
    {
        if ($this->request->origin === '') {
            return Response::json(400, ['error' => 'Origin is required.']);
        }

        $matchedOrigin = UrlUtils::findMatchedOrigin($this->request->origin, $this->config->allowedOrigins);
        if ($matchedOrigin === null) {
            return Response::json(403, ['error' => 'Forbidden.']);
        }

        $corsHeaders = [
            'Access-Control-Allow-Origin'  => $matchedOrigin,
            'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers' => 'Content-Type, Accept',
            'Access-Control-Max-Age'       => '86400',
            'Vary'                         => 'Origin',
        ];

        if ($this->request->method === 'OPTIONS') {
            return Response::noContent()->withHeaders($corsHeaders);
        }

        return $next()->withHeaders($corsHeaders);
    }
}
