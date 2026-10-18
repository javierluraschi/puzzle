// Background solve of one puzzle (worker thread): candidate table for all sides, assembly, and the
// results written next to the puzzle (matches.json for the per-side lists, solution.json).
import { parentPort, workerData } from 'node:worker_threads';
import { analyzedPieces, fingerprint, file, writeJson } from './store.js';
import { candidateTable } from './match.js';
import { solve } from './solver.js';

const { id } = workerData;
const started = Date.now();
const status = (state, message, extra = {}) =>
  writeJson(file(id, 'status.json'), { state, message, started: Math.floor(started / 1000), updated: Math.floor(Date.now() / 1000), ...extra });

try {
  const pieces = analyzedPieces(id);
  if (pieces.size < 2) throw new Error('At least two analyzed pieces are needed.');
  const print = fingerprint(pieces.keys());
  status('running', 'Comparing every side with every other side…', { pieces: pieces.size });
  const candidates = candidateTable(pieces);
  writeJson(file(id, 'matches.json'), { fingerprint: print, typicalOffset: candidates.typicalOffset, table: [...candidates.table] });
  status('running', 'Assembling…', { pieces: pieces.size });
  const result = solve(pieces, candidates, { onProgress: ({ groups }) => status('running', 'Assembling…', { pieces: pieces.size, groups }) });
  writeJson(file(id, 'solution.json'), {
    version: 2,
    fingerprint: print,
    created: Math.floor(Date.now() / 1000),
    duration: Math.round((Date.now() - started) / 1000),
    pieces: pieces.size,
    typicalOffset: result.typicalOffset,
    groups: result.groups,
  });
  const biggest = result.groups[0]?.placements.length ?? 0;
  status('done', `Solved: biggest group has ${biggest} of ${pieces.size} pieces.`, { pieces: pieces.size, groups: result.groups.length, biggestGroup: biggest });
} catch (error) {
  status('failed', error.message);
}
parentPort?.postMessage('done');
