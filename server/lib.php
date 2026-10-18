<?php

declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Bywulf\Jigsawlutioner\Dto\Context\ByWulfBorderFinderContext;
use Bywulf\Jigsawlutioner\Dto\Piece;
use Bywulf\Jigsawlutioner\Dto\Point;
use Bywulf\Jigsawlutioner\Exception\JigsawlutionerException;
use Bywulf\Jigsawlutioner\Service\BorderFinder\ByWulfBorderFinder;
use Bywulf\Jigsawlutioner\Service\PieceAnalyzer;
use Bywulf\Jigsawlutioner\Service\PointService;
use Bywulf\Jigsawlutioner\Service\SideFinder\ByWulfSideFinder;
use Bywulf\Jigsawlutioner\Service\SideMatcher\WeightedMatcher;
use Bywulf\Jigsawlutioner\SideClassifier\DirectionClassifier;

const MAX_PIECES = 1500;
const MATCHES_PER_SIDE = 12;
const PUZZLE_TTL_DAYS = 60;
const MASK_WIDTH = 1000;
const MASK_HEIGHT = 1060;
// Median piece area and mean corner-to-corner side length (pixels) of the backlit scans
// jigsawlutioner's classifiers were trained on
const TARGET_PIECE_AREA = 100000;
const CANONICAL_SIDE_LENGTH = 305.0;
// findDuplicate score (max 4) above which a new scan is flagged as probably already scanned
const DUPLICATE_SCORE = 3.6;

function dataDir(): string
{
    $dir = rtrim(getenv('DATA_DIR') ?: __DIR__ . '/../data', '/');
    if (!is_dir($dir . '/puzzles')) {
        mkdir($dir . '/puzzles', 0775, true);
    }

    return $dir;
}

function isValidPuzzleId(string $id): bool
{
    return (bool) preg_match('/^[a-z0-9]{10}$/', $id);
}

function puzzleDir(string $id): string
{
    if (!isValidPuzzleId($id)) {
        throw new InvalidArgumentException('Invalid puzzle id');
    }

    return dataDir() . '/puzzles/' . $id;
}

function readJson(string $path, mixed $default = null): mixed
{
    if (!is_file($path)) {
        return $default;
    }
    $content = file_get_contents($path);

    return $content === false || $content === '' ? $default : json_decode($content, true);
}

function writeJson(string $path, mixed $data): void
{
    $tmp = $path . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES));
    rename($tmp, $path);
}

/**
 * Runs $callback while holding an exclusive lock on the puzzle (used to hand out piece numbers).
 */
function withPuzzleLock(string $id, callable $callback): mixed
{
    $handle = fopen(puzzleDir($id) . '/.lock', 'c');
    flock($handle, LOCK_EX);
    try {
        return $callback();
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function createPuzzle(string $name): string
{
    cleanupOldPuzzles();

    do {
        $id = substr(str_shuffle(str_repeat('abcdefghijkmnopqrstuvwxyz23456789', 3)), 0, 10);
    } while (is_dir(dataDir() . '/puzzles/' . $id));

    mkdir(puzzleDir($id) . '/pieces', 0775, true);
    writeJson(puzzleDir($id) . '/meta.json', [
        'id' => $id,
        'name' => mb_substr($name, 0, 80),
        'created' => time(),
        'nextPiece' => 1,
    ]);

    return $id;
}

function cleanupOldPuzzles(): void
{
    foreach (glob(dataDir() . '/puzzles/*/meta.json') ?: [] as $metaFile) {
        if (filemtime(dirname($metaFile)) < time() - PUZZLE_TTL_DAYS * 86400 && filemtime($metaFile) < time() - PUZZLE_TTL_DAYS * 86400) {
            exec('rm -rf ' . escapeshellarg(dirname($metaFile)));
        }
    }
}

function touchPuzzle(string $id): void
{
    @touch(puzzleDir($id));
}

/**
 * @return array<int, array<string, mixed>> piece summaries keyed by piece number
 */
function loadPieceSummaries(string $id): array
{
    $summaries = [];
    foreach (glob(puzzleDir($id) . '/pieces/*.json') ?: [] as $file) {
        // N.json only (N_contour.json holds the raw contour)
        if (!preg_match('/^\d+\.json$/', basename($file))) {
            continue;
        }
        $summary = readJson($file);
        if (is_array($summary) && isset($summary['index'])) {
            $summaries[$summary['index']] = $summary;
        }
    }
    ksort($summaries);

    return $summaries;
}

/**
 * @return array<int, Piece> successfully analyzed pieces keyed by piece number
 */
function loadPieces(string $id): array
{
    $pieces = [];
    foreach (glob(puzzleDir($id) . '/pieces/*.ser') ?: [] as $file) {
        $piece = Piece::fromSerialized(file_get_contents($file));
        $pieces[$piece->getIndex()] = $piece;
    }
    ksort($pieces);

    return $pieces;
}

/**
 * A fingerprint of the set of analyzed pieces, so cached matching results can be invalidated.
 */
function piecesFingerprint(array $pieceIndexes): string
{
    sort($pieceIndexes);

    return md5(implode(',', $pieceIndexes));
}

/**
 * Contour as sent by the scanner: [[x, y], ...] in "shape units" (centered, sqrt(area) = 1000).
 *
 * @return array<int, array{float, float}>
 */
function validateContour(mixed $contour): array
{
    if (!is_array($contour) || count($contour) < 100 || count($contour) > 5000) {
        throw new InvalidArgumentException('contour must have 100 to 5000 points');
    }
    $points = [];
    foreach ($contour as $point) {
        if (!is_array($point) || count($point) !== 2 || !is_numeric($point[0]) || !is_numeric($point[1])) {
            throw new InvalidArgumentException('contour points must be [x, y] numbers');
        }
        $x = (float) $point[0];
        $y = (float) $point[1];
        if (!is_finite($x) || !is_finite($y) || abs($x) > 3000 || abs($y) > 3000) {
            throw new InvalidArgumentException('contour point out of range');
        }
        $points[] = [$x, $y];
    }
    if (abs(polygonArea($points)) < 1e5) {
        throw new InvalidArgumentException('contour encloses no area');
    }

    return $points;
}

function polygonArea(array $points): float
{
    $sum = 0.0;
    $n = count($points);
    for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
        $sum += $points[$j][0] * $points[$i][1] - $points[$i][0] * $points[$j][1];
    }

    return $sum / 2;
}

/**
 * The silhouette jigsawlutioner expects (black piece on white, 1000x1060), drawn from the
 * contour at `scale` pixels per shape unit. Drawn at 2x and downsampled, so the analyzer's 50%
 * threshold lands on the sub-pixel contour.
 */
function rasterizeContour(array $contour, float $scale): GdImage
{
    $factor = 2;
    $big = imagecreatetruecolor(MASK_WIDTH * $factor, MASK_HEIGHT * $factor);
    imagefill($big, 0, 0, imagecolorallocate($big, 255, 255, 255));
    $flat = [];
    foreach ($contour as [$x, $y]) {
        $flat[] = (int) round(($x * $scale + MASK_WIDTH / 2) * $factor);
        $flat[] = (int) round(($y * $scale + MASK_HEIGHT / 2) * $factor);
    }
    imagefilledpolygon($big, $flat, imagecolorallocate($big, 0, 0, 0));
    $image = imagecreatetruecolor(MASK_WIDTH, MASK_HEIGHT);
    imagecopyresampled($image, $big, 0, 0, 0, 0, MASK_WIDTH, MASK_HEIGHT, MASK_WIDTH * $factor, MASK_HEIGHT * $factor);
    imagedestroy($big);

    return $image;
}

/**
 * Runs jigsawlutioner's piece analysis on a contour. Pieces are scanned at unknown distances, so
 * the scale is normalized: a first pass finds the corners, a second pass redraws the piece so its
 * mean corner-to-corner side length matches the scans the classifiers were trained on.
 *
 * @return array{piece: ?Piece, image: GdImage, scale: float, error: ?string}
 */
function analyzeContour(array $contour, int $index, ?float $knownScale = null): array
{
    $analyzer = new PieceAnalyzer(new ByWulfBorderFinder(), new ByWulfSideFinder());
    $pointService = new PointService();
    // with a known scale (pixels at jigsawlutioner's resolution per shape unit) one pass suffices
    $scale = $knownScale ?? sqrt(TARGET_PIECE_AREA) / 1000;
    $result = null;
    for ($pass = 0; $pass < ($knownScale === null ? 2 : 1); ++$pass) {
        $image = rasterizeContour($contour, $scale);
        try {
            $piece = $analyzer->getPieceFromImage($index, $image, new ByWulfBorderFinderContext(threshold: 0.5));
        } catch (JigsawlutionerException $exception) {
            $error = $exception->getMessage() ?: (new ReflectionClass($exception))->getShortName();
            // keep the first pass result if the rescaled one fails
            return $result ?? ['piece' => null, 'image' => $image, 'scale' => $scale, 'error' => $error];
        }
        if ($result !== null) {
            imagedestroy($result['image']);
        }
        $result = ['piece' => $piece, 'image' => $image, 'scale' => $scale, 'error' => null];

        $lengths = array_map(static fn ($side): float => $pointService->getDistanceBetweenPoints($side->getStartPoint(), $side->getEndPoint()), $piece->getSides());
        $mean = array_sum($lengths) / 4;
        if (abs($mean - CANONICAL_SIDE_LENGTH) / CANONICAL_SIDE_LENGTH < 0.015) {
            break;
        }
        $scale *= CANONICAL_SIDE_LENGTH / $mean;
    }

    return $result;
}

/**
 * Analyzes and stores one scanned piece.
 *
 * @return array<string, mixed> the piece summary that is sent to the browser
 */
function savePiece(string $id, int $index, string $label, array $contour, array $quality, array $existing, ?float $knownScale = null): array
{
    $dir = puzzleDir($id) . '/pieces';
    $analysis = analyzeContour($contour, $index, $knownScale);
    $scale = $analysis['scale'];

    $summary = [
        'index' => $index,
        'label' => $label,
        'created' => time(),
        'quality' => $quality,
        // analysis pixels per contour unit
        'scale' => round($scale, 6),
        'imageWidth' => MASK_WIDTH,
        'imageHeight' => MASK_HEIGHT,
        // the outline in the coordinates of the analyzed silhouette (where corners etc. live)
        'outline' => array_map(
            static fn (array $p): array => [round($p[0] * $scale + MASK_WIDTH / 2, 1), round($p[1] * $scale + MASK_HEIGHT / 2, 1)],
            resamplePolygon($contour, 400)
        ),
        'ok' => false,
    ];

    if ($analysis['piece'] !== null) {
        $piece = $analysis['piece'];
        $piece->reduceData();
        file_put_contents($dir . '/' . $index . '.ser', serialize($piece));
        $summary = array_merge($summary, describePiece($piece), ['ok' => true]);
        $duplicate = findDuplicate($piece, $existing);
        if ($duplicate !== null) {
            $summary['possibleDuplicate'] = $duplicate;
        }
    } else {
        $summary['error'] = $analysis['error'];
        @unlink($dir . '/' . $index . '.ser');
    }
    // The analyzer paints the detected border, corners and side profiles onto the image
    imagepng($analysis['image'], $dir . '/' . $index . '_debug.png', 6);
    imagedestroy($analysis['image']);

    writeJson($dir . '/' . $index . '_contour.json', $contour);
    writeJson($dir . '/' . $index . '.json', $summary);

    return $summary;
}

/**
 * Was this piece scanned before? Compares all four sides with each existing piece in all four
 * rotations (like jigsawlutioner's PieceRecognizer, but returning a score so it can be
 * thresholded): 4.0 means every side looks identical.
 *
 * @param array<int, array{piece: Piece, label: string}> $existing
 */
function findDuplicate(Piece $piece, array $existing): ?array
{
    $best = null;
    foreach ($existing as $index => ['piece' => $other, 'label' => $label]) {
        for ($offset = 0; $offset < 4; ++$offset) {
            $score = 0.0;
            for ($s = 0; $s < 4; ++$s) {
                $side = $piece->getSide($s);
                $otherSide = $other->getSide($s + $offset);
                try {
                    if ($side->getDirection() !== $otherSide->getDirection()) {
                        continue 2;
                    }
                } catch (Throwable) {
                    continue 2;
                }
                $values = [];
                foreach ($side->getClassifiers() as $class => $classifier) {
                    try {
                        $values[] = $classifier->compareSameSide($otherSide->getClassifier($class));
                    } catch (Throwable) {
                    }
                }
                $score += $values === [] ? 0 : array_sum($values) / count($values);
            }
            if ($best === null || $score > $best['score']) {
                $best = ['index' => $index, 'label' => $label, 'score' => round($score, 3)];
            }
        }
    }

    return $best !== null && $best['score'] >= DUPLICATE_SCORE ? $best : null;
}

/**
 * @return array<int, array{float, float}>
 */
function resamplePolygon(array $points, int $count): array
{
    $n = count($points);
    $lengths = [];
    $total = 0.0;
    for ($i = 0; $i < $n; ++$i) {
        $next = $points[($i + 1) % $n];
        $lengths[$i] = hypot($next[0] - $points[$i][0], $next[1] - $points[$i][1]);
        $total += $lengths[$i];
    }
    $step = $total / $count;
    $out = [];
    $i = 0;
    $along = 0.0;
    for ($k = 0; $k < $count; ++$k) {
        $target = $k * $step;
        while ($i < $n - 1 && $along + $lengths[$i] < $target) {
            $along += $lengths[$i];
            ++$i;
        }
        $t = $lengths[$i] > 0 ? ($target - $along) / $lengths[$i] : 0;
        $a = $points[$i];
        $b = $points[($i + 1) % $n];
        $out[] = [$a[0] + ($b[0] - $a[0]) * $t, $a[1] + ($b[1] - $a[1]) * $t];
    }

    return $out;
}

function nextLabel(array $summaries): string
{
    $max = 0;
    foreach ($summaries as $summary) {
        if (preg_match('/^\d+$/', (string) ($summary['label'] ?? ''))) {
            $max = max($max, (int) $summary['label']);
        }
    }

    return (string) ($max + 1);
}

/**
 * @return array<string, mixed>
 */
function describePiece(Piece $piece): array
{
    $pointService = new PointService();
    $sides = $piece->getSides();

    $directions = [];
    foreach ($sides as $side) {
        try {
            $directions[] = match ($side->getDirection()) {
                DirectionClassifier::NOP_STRAIGHT => 'flat',
                DirectionClassifier::NOP_OUTSIDE => 'out',
                DirectionClassifier::NOP_INSIDE => 'in',
                default => 'unknown',
            };
        } catch (Throwable) {
            $directions[] = 'unknown';
        }
    }
    $flatSides = count(array_filter($directions, static fn (string $d): bool => $d === 'flat'));

    // Rotation (degrees, CSS clockwise) that brings side $top to the top, the same way jigsawlutioner-cli renders solutions
    $rotations = [];
    for ($top = 0; $top < 4; ++$top) {
        $topSide = $piece->getSide($top);
        $bottomSide = $piece->getSide($top + 2);
        $rotations[] = round(-$pointService->getAverageRotation(
            $topSide->getEndPoint(),
            $bottomSide->getStartPoint(),
            $bottomSide->getEndPoint(),
            $topSide->getStartPoint()
        ), 2);
    }

    $corners = array_map(static fn ($side): array => pointToArray($side->getStartPoint()), $sides);
    $center = $pointService->getAveragePoint(array_map(static fn ($side): Point => $side->getStartPoint(), $sides));

    $sideLengths = array_map(
        static fn ($side): float => round($pointService->getDistanceBetweenPoints($side->getStartPoint(), $side->getEndPoint()), 1),
        $sides
    );

    return [
        'corners' => $corners,
        'center' => pointToArray($center),
        'directions' => $directions,
        'sideLengths' => $sideLengths,
        'rotations' => $rotations,
        'kind' => match (true) {
            $flatSides >= 2 => 'corner',
            $flatSides === 1 => 'edge',
            default => 'inner',
        },
    ];
}

function pointToArray(Point $point): array
{
    return [round($point->getX(), 1), round($point->getY(), 1)];
}

function sideKey(int $piece, int $side): string
{
    return $piece . '_' . (($side % 4 + 4) % 4);
}

/**
 * Best matching sides for every side of one piece, computed directly with the WeightedMatcher.
 *
 * @param array<int, Piece> $pieces
 *
 * @return array<int, array<string, float>>
 */
function computeMatchesForPiece(Piece $piece, array $pieces): array
{
    $allSides = [];
    foreach ($pieces as $other) {
        if ($other->getIndex() === $piece->getIndex()) {
            continue;
        }
        foreach ($other->getSides() as $sideIndex => $side) {
            $allSides[sideKey($other->getIndex(), $sideIndex)] = $side;
        }
    }

    $matcher = new WeightedMatcher();
    $result = [];
    foreach ($piece->getSides() as $sideIndex => $side) {
        $probabilities = array_filter($matcher->getMatchingProbabilities($side, $allSides));
        arsort($probabilities);
        $result[$sideIndex] = array_slice($probabilities, 0, MATCHES_PER_SIDE, true);
    }

    return $result;
}

function solveStatus(string $id): array
{
    $status = readJson(puzzleDir($id) . '/status.json', ['state' => 'idle']);

    // A solver process that died without reporting back (e.g. container restart)
    $alive = isset($status['pid']) && function_exists('posix_kill') ? posix_kill((int) $status['pid'], 0) : ($status['updated'] ?? 0) > time() - 1800;
    if (in_array($status['state'], ['queued', 'running'], true) && !$alive && ($status['updated'] ?? 0) < time() - 5) {
        $status['state'] = 'failed';
        $status['message'] = 'The solver stopped unexpectedly. Please try again.';
    }

    return $status;
}
