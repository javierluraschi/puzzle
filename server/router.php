<?php

declare(strict_types=1);

/*
 * Router for the PHP built-in web server: php -S 0.0.0.0:8080 -t public server/router.php
 * Serves the single page app from public/ and the JSON API under /api/.
 */

// Cross-origin isolation enables SharedArrayBuffer, i.e. multi-threaded WASM inference
header('Cross-Origin-Opener-Policy: same-origin');
header('Cross-Origin-Embedder-Policy: require-corp');
header('Cross-Origin-Resource-Policy: same-origin');

$publicDir = realpath(__DIR__ . '/../public');
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';

if (!str_starts_with($path, '/api/')) {
    $file = realpath($publicDir . $path);
    if ($file !== false && str_starts_with($file, $publicDir) && is_file($file)) {
        serveStatic($file);
    }
    // Client side routes like /p/<id> all load the app
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    readfile($publicDir . '/index.html');

    return true;
}

function serveStatic(string $file): never
{
    $types = [
        'html' => 'text/html; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8',
        'mjs' => 'text/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'json' => 'application/json',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'wasm' => 'application/wasm',
        'onnx' => 'application/octet-stream',
        'webmanifest' => 'application/manifest+json',
    ];
    $extension = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$extension] ?? 'application/octet-stream'));
    // models and the inference runtime are versioned by path; app code revalidates
    $immutable = str_contains($file, '/models/') || str_contains($file, '/vendor/');
    header('Cache-Control: ' . ($immutable ? 'public, max-age=31536000, immutable' : 'no-cache'));
    $etag = '"' . md5($file . filemtime($file) . filesize($file)) . '"';
    header('ETag: ' . $etag);
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        exit;
    }
    header('Content-Length: ' . filesize($file));
    readfile($file);
    exit;
}

require_once __DIR__ . '/lib.php';

function respond(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400, array $extra = []): never
{
    respond(['error' => $message] + $extra, $status);
}

function requestJson(): array
{
    $data = json_decode(file_get_contents('php://input') ?: '{}', true);

    return is_array($data) ? $data : [];
}

function requirePuzzle(string $id): string
{
    if (!isValidPuzzleId($id) || !is_file(puzzleDir($id) . '/meta.json')) {
        fail('Puzzle not found', 404);
    }
    touchPuzzle($id);

    return $id;
}

function cleanLabel(mixed $label): string
{
    $label = trim(preg_replace('/\s+/', ' ', (string) $label));
    if ($label === '' || mb_strlen($label) > 24) {
        fail('A label must have 1 to 24 characters');
    }

    return $label;
}

/** Piece index with this label, other than $except */
function labelOwner(array $summaries, string $label, ?int $except = null): ?int
{
    foreach ($summaries as $index => $summary) {
        if ($index !== $except && mb_strtolower((string) ($summary['label'] ?? '')) === mb_strtolower($label)) {
            return $index;
        }
    }

    return null;
}

function puzzleResponse(string $id): array
{
    $meta = readJson(puzzleDir($id) . '/meta.json');
    $pieces = loadPieceSummaries($id);

    return [
        'id' => $id,
        'name' => $meta['name'],
        'created' => $meta['created'],
        'nextLabel' => nextLabel($pieces),
        'pieces' => array_values($pieces),
        'solve' => solveStatus($id),
    ];
}

$method = $_SERVER['REQUEST_METHOD'];
$route = substr($path, strlen('/api'));

try {
    if ($method === 'GET' && $route === '/health') {
        respond(['ok' => true]);
    }

    if ($method === 'POST' && $route === '/puzzles') {
        $body = requestJson();
        $id = createPuzzle(trim((string) ($body['name'] ?? '')) ?: 'My puzzle');
        respond(puzzleResponse($id), 201);
    }

    if (!preg_match('#^/puzzles/([a-z0-9]{10})(/.*)?$#', $route, $m)) {
        fail('Not found', 404);
    }
    $id = requirePuzzle($m[1]);
    $sub = $m[2] ?? '';
    $dir = puzzleDir($id);

    if ($method === 'GET' && $sub === '') {
        respond(puzzleResponse($id));
    }

    if ($method === 'PATCH' && $sub === '') {
        $body = requestJson();
        withPuzzleLock($id, static function () use ($dir, $body): void {
            $meta = readJson($dir . '/meta.json');
            if (isset($body['name'])) {
                $meta['name'] = mb_substr(trim((string) $body['name']), 0, 80) ?: $meta['name'];
            }
            writeJson($dir . '/meta.json', $meta);
        });
        respond(puzzleResponse($id));
    }

    // Everything the catalog knows, for backup / other tools
    if ($method === 'GET' && $sub === '/export') {
        $pieces = [];
        foreach (loadPieceSummaries($id) as $index => $summary) {
            $pieces[] = [
                'label' => $summary['label'] ?? (string) $index,
                'contour' => readJson($dir . '/pieces/' . $index . '_contour.json'),
                'quality' => $summary['quality'] ?? null,
                'kind' => $summary['kind'] ?? null,
                'sides' => $summary['directions'] ?? null,
            ];
        }
        header('Content-Disposition: attachment; filename="puzzle-' . $id . '.json"');
        respond(['format' => 'jigsaw-catalog/1', 'units' => 'centered, sqrt(area) = 1000', 'name' => readJson($dir . '/meta.json')['name'], 'pieces' => $pieces]);
    }

    // A scanned piece: label + contour (the scanner never uploads images)
    if ($method === 'POST' && $sub === '/pieces') {
        $body = requestJson();
        $label = cleanLabel($body['label'] ?? '');
        $contour = validateContour($body['contour'] ?? null);
        $quality = is_array($body['quality'] ?? null) ? array_slice($body['quality'], 0, 20) : [];
        $replace = isset($body['replace']) ? (int) $body['replace'] : null;
        // optional absolute size (e.g. from a flatbed scan or a calibration mat): pixels at
        // jigsawlutioner's resolution per contour unit; otherwise every piece is size-normalized
        $knownScale = isset($body['scale']) && is_numeric($body['scale']) && $body['scale'] > 0.05 && $body['scale'] < 2 ? (float) $body['scale'] : null;
        // measured on the scan card: sqrt(area) in millimetres
        $sizeMm = isset($body['sizeMm']) && is_numeric($body['sizeMm']) && $body['sizeMm'] > 3 && $body['sizeMm'] < 100 ? (float) $body['sizeMm'] : null;
        if ($knownScale === null && $sizeMm !== null) {
            $pxPerMm = readJson($dir . '/meta.json')['pxPerMm'] ?? null;
            if ($pxPerMm !== null) {
                $knownScale = $pxPerMm * $sizeMm / 1000;
            }
        }

        $index = withPuzzleLock($id, static function () use ($dir, $id, $label, $replace): int {
            $summaries = loadPieceSummaries($id);
            $owner = labelOwner($summaries, $label, $replace);
            if ($owner !== null) {
                fail('Label "' . $label . '" is already used', 409, ['index' => $owner]);
            }
            if ($replace !== null) {
                if (!isset($summaries[$replace])) {
                    fail('Piece to replace not found', 404);
                }

                return $replace;
            }
            if (count($summaries) >= MAX_PIECES) {
                fail('A puzzle can have at most ' . MAX_PIECES . ' pieces');
            }
            $meta = readJson($dir . '/meta.json');
            $index = $meta['nextPiece']++;
            writeJson($dir . '/meta.json', $meta);
            // reserve the number right away
            writeJson($dir . '/pieces/' . $index . '.json', ['index' => $index, 'label' => $label, 'ok' => false, 'pending' => true]);

            return $index;
        });

        $existing = [];
        foreach (loadPieces($id) as $otherIndex => $piece) {
            if ($otherIndex !== $index) {
                $existing[$otherIndex] = ['piece' => $piece, 'label' => readJson($dir . '/pieces/' . $otherIndex . '.json')['label'] ?? (string) $otherIndex];
            }
        }
        $summary = savePiece($id, $index, $label, $contour, $quality, $existing, $knownScale);
        if ($sizeMm !== null) {
            $summary['sizeMm'] = $sizeMm;
            writeJson($dir . '/pieces/' . $index . '.json', $summary);
            // the first measured piece fixes the puzzle's millimetre -> analysis pixel factor, so
            // every later card scan keeps its true size relative to it
            if ($summary['ok'] && $knownScale === null) {
                withPuzzleLock($id, static function () use ($dir, $summary, $sizeMm): void {
                    $meta = readJson($dir . '/meta.json');
                    $meta['pxPerMm'] ??= $summary['scale'] * 1000 / $sizeMm;
                    writeJson($dir . '/meta.json', $meta);
                });
            }
        }
        respond($summary + ['nextLabel' => nextLabel(loadPieceSummaries($id))], $replace !== null ? 200 : 201);
    }

    if (preg_match('#^/pieces/(\d+)$#', $sub, $pm)) {
        $index = (int) $pm[1];
        if (!is_file($dir . '/pieces/' . $index . '.json')) {
            fail('Piece not found', 404);
        }
        if ($method === 'DELETE') {
            foreach (glob($dir . '/pieces/' . $index . '[._]*') ?: [] as $file) {
                unlink($file);
            }
            respond(['deleted' => $index, 'nextLabel' => nextLabel(loadPieceSummaries($id))]);
        }
        if ($method === 'PATCH') {
            $label = cleanLabel(requestJson()['label'] ?? '');
            $summary = withPuzzleLock($id, static function () use ($dir, $id, $index, $label): array {
                $owner = labelOwner(loadPieceSummaries($id), $label, $index);
                if ($owner !== null) {
                    fail('Label "' . $label . '" is already used', 409, ['index' => $owner]);
                }
                $summary = readJson($dir . '/pieces/' . $index . '.json');
                $summary['label'] = $label;
                writeJson($dir . '/pieces/' . $index . '.json', $summary);

                return $summary;
            });
            respond($summary);
        }
        if ($method === 'GET') {
            respond(readJson($dir . '/pieces/' . $index . '.json'));
        }
    }

    // Best candidates for every side of one piece: "what fits here?"
    if ($method === 'GET' && preg_match('#^/pieces/(\d+)/matches$#', $sub, $pm)) {
        $index = (int) $pm[1];
        $pieces = loadPieces($id);
        if (!isset($pieces[$index])) {
            fail('Piece was not analyzed successfully', 404);
        }

        $cached = readJson($dir . '/matches.json');
        $sides = [];
        if (is_array($cached) && $cached['fingerprint'] === piecesFingerprint(array_keys($pieces))) {
            for ($s = 0; $s < 4; ++$s) {
                $sides[$s] = $cached['matches'][sideKey($index, $s)] ?? [];
            }
        } else {
            $sides = computeMatchesForPiece($pieces[$index], $pieces);
        }

        $result = [];
        foreach ($sides as $sideIndex => $probabilities) {
            $candidates = [];
            foreach ($probabilities as $key => $probability) {
                [$otherPiece, $otherSide] = array_map('intval', explode('_', (string) $key));
                $candidates[] = ['piece' => $otherPiece, 'side' => $otherSide, 'probability' => $probability];
            }
            $result[] = ['side' => $sideIndex, 'candidates' => $candidates];
        }
        respond(['piece' => $index, 'sides' => $result]);
    }

    if ($method === 'POST' && $sub === '/solve') {
        $status = solveStatus($id);
        if (in_array($status['state'], ['queued', 'running'], true)) {
            respond($status, 202);
        }
        writeJson($dir . '/status.json', ['state' => 'queued', 'message' => 'Starting solver…', 'updated' => time(), 'started' => time()]);
        $command = sprintf(
            '%s %s %s > %s 2>&1 &',
            escapeshellarg(PHP_BINARY === '' ? 'php' : PHP_BINARY),
            escapeshellarg(__DIR__ . '/solve.php'),
            escapeshellarg($id),
            escapeshellarg($dir . '/solve.log')
        );
        exec($command);
        respond(solveStatus($id), 202);
    }

    if ($method === 'GET' && $sub === '/solution') {
        $pieceIndexes = array_keys(loadPieces($id));
        $solution = readJson($dir . '/solution.json');
        if (is_array($solution)) {
            $solution['stale'] = $solution['fingerprint'] !== piecesFingerprint($pieceIndexes);
        }
        respond(['status' => solveStatus($id), 'solution' => $solution]);
    }

    // What the analyzer saw: the silhouette with detected border, corners and side profiles
    if ($method === 'GET' && preg_match('#^/files/pieces/(\d+_debug\.png)$#', $sub, $fm)) {
        $file = $dir . '/pieces/' . $fm[1];
        if (!is_file($file)) {
            fail('File not found', 404);
        }
        header('Content-Type: image/png');
        header('Cache-Control: no-cache');
        header('Content-Length: ' . filesize($file));
        readfile($file);
        exit;
    }

    fail('Not found', 404);
} catch (InvalidArgumentException $exception) {
    fail($exception->getMessage());
} catch (Throwable $exception) {
    error_log((string) $exception);
    fail('Server error: ' . $exception->getMessage(), 500);
}
