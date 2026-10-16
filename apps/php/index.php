<?php

declare(strict_types=1);

// Does not show PHP errors in the browser (so that no information leaks).
ini_set('display_errors', '0');
ini_set('log_errors', '1');

require_once __DIR__ . '/src/App.php';

$app = new App(__DIR__);
$app->handle(Request::fromGlobals())->send();
