<?php

declare(strict_types=1);

require_once __DIR__ . '/../Config/AppConfig.php';
require_once __DIR__ . '/../Http/Request.php';
require_once __DIR__ . '/../Http/Response.php';
require_once __DIR__ . '/../Util/UrlUtils.php';

/**
 * CORS ミドルウェア。
 *
 * Origin 検証、プリフライト処理、CORS ヘッダー付与を一括で行う。
 * 検証に失敗した場合はハンドラを呼ばずにエラーレスポンスを返す。
 */
final readonly class CorsMiddleware
{
    public function __construct(
        private Request    $request,
        private AppConfig  $config,
    ) {}

    /**
     * ミドルウェアとしてハンドラをラップする。
     *
     * @param \Closure(): Response $next 次のハンドラ
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
