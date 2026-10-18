<?php

declare(strict_types=1);

/*
 * Background solver: php server/solve.php <puzzleId>
 *
 * Builds the jigsawlutioner matching map for all analyzed pieces, runs the ByWulfSolver
 * and writes solution.json + matches.json into the puzzle directory.
 */

require_once __DIR__ . '/lib.php';

use Bywulf\Jigsawlutioner\Dto\Group;
use Bywulf\Jigsawlutioner\Dto\Placement;
use Bywulf\Jigsawlutioner\Dto\ReducedPiece;
use Bywulf\Jigsawlutioner\Service\MatchingMapGenerator;
use Bywulf\Jigsawlutioner\Service\PuzzleSolver\ByWulfSolver;
use Bywulf\Jigsawlutioner\Service\SideMatcher\WeightedMatcher;

const MAX_PARALLEL_SOLVES = 2;

ini_set('memory_limit', getenv('SOLVER_MEMORY_LIMIT') ?: '1536M');
set_time_limit(0);

$id = $argv[1] ?? '';
$dir = puzzleDir($id);
$statusFile = $dir . '/status.json';
$startedAt = time();

$setStatus = static function (string $state, string $message, array $extra = []) use ($statusFile, $startedAt): void {
    writeJson($statusFile, [
        'state' => $state,
        'message' => $message,
        'pid' => getmypid(),
        'started' => $startedAt,
        'updated' => time(),
    ] + $extra);
};

// Limit the number of solvers running at the same time across all puzzles
$slot = null;
while ($slot === null) {
    for ($i = 0; $i < MAX_PARALLEL_SOLVES; ++$i) {
        $handle = fopen(dataDir() . '/.solver-slot-' . $i, 'c');
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            $slot = $handle;
            break;
        }
        fclose($handle);
    }
    if ($slot === null) {
        $setStatus('queued', 'Waiting for a free solver…');
        sleep(2);
    }
}

try {
    $pieces = loadPieces($id);
    if (count($pieces) < 2) {
        throw new RuntimeException('At least two successfully analyzed pieces are needed.');
    }
    $fingerprint = piecesFingerprint(array_keys($pieces));

    $setStatus('running', 'Comparing every side with every other side…', ['pieces' => count($pieces)]);
    $matchingMap = (new MatchingMapGenerator(new WeightedMatcher(), (int) (getenv('SOLVER_WORKERS') ?: 2)))->getMatchingMap($pieces);

    // Keep the best candidates per side for the "what fits here?" view
    $topMatches = [];
    foreach ($matchingMap as $key => $probabilities) {
        $topMatches[$key] = array_slice($probabilities, 0, MATCHES_PER_SIDE, true);
    }
    writeJson($dir . '/matches.json', ['fingerprint' => $fingerprint, 'matches' => $topMatches]);

    $groupsCount = count($pieces);
    $biggestGroup = 1;
    $lastWrite = 0;
    $solver = new ByWulfSolver();
    $solver->setStepProgressionCallback(static function (string $message, int $groups, int $biggest) use ($setStatus, &$lastWrite, &$groupsCount, &$biggestGroup, $pieces): void {
        $groupsCount = $groups;
        $biggestGroup = $biggest;
        if (microtime(true) - $lastWrite > 0.5) {
            $setStatus('running', $message, ['pieces' => count($pieces), 'groups' => $groups, 'biggestGroup' => $biggest]);
            $lastWrite = microtime(true);
        }
    });

    $setStatus('running', 'Assembling groups…', ['pieces' => count($pieces)]);
    $solution = $solver->findSolution(
        array_map(static fn ($piece): ReducedPiece => ReducedPiece::fromPiece($piece), $pieces),
        $matchingMap,
    );

    $groups = array_map(static function (Group $group): array {
        return [
            'placements' => array_map(static function (Placement $placement): array {
                $links = [];
                foreach ((array) $placement->getContext() as $direction => $context) {
                    $probability = null;
                    if (($context['matchedProbabilityIndex'] ?? null) !== null && $context['matchedProbabilityIndex'] !== false) {
                        $probability = array_values($context['probabilities'])[$context['matchedProbabilityIndex']] ?? null;
                    }
                    $links[$direction] = $probability;
                }

                return [
                    'piece' => $placement->getPiece()->getIndex(),
                    'x' => $placement->getX(),
                    'y' => $placement->getY(),
                    'top' => $placement->getTopSideIndex(),
                    // probability of the match towards top, left, bottom, right
                    'links' => $links,
                ];
            }, array_values($group->getPlacements())),
        ];
    }, $solution->getGroups());

    writeJson($dir . '/solution.json', [
        'fingerprint' => $fingerprint,
        'created' => time(),
        'duration' => time() - $startedAt,
        'pieces' => count($pieces),
        'groups' => $groups,
    ]);

    $biggest = $groups === [] ? 0 : max(array_map(static fn (array $g): int => count($g['placements']), $groups));
    $setStatus('done', sprintf('Solved: biggest group has %d of %d pieces.', $biggest, count($pieces)), [
        'pieces' => count($pieces),
        'groups' => count($groups),
        'biggestGroup' => $biggest,
    ]);
} catch (Throwable $exception) {
    fwrite(STDERR, (string) $exception);
    $setStatus('failed', $exception->getMessage());
    exit(1);
} finally {
    flock($slot, LOCK_UN);
}
