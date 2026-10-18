// Puzzle storage: one directory per puzzle under $DATA_DIR/puzzles/<id>/ with JSON files.
//   meta.json                 { id, name, created, nextPiece }
//   pieces/<n>.json           piece summary (label, analysis for display, quality)
//   pieces/<n>_contour.json   the scanned contour (centered, sqrt(area) = 1000 units)
//   pieces/<n>_sides.json     side descriptors for matching
//   status.json, solution.json, matches.json

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { analyzePiece } from './piece.js';

export const ANALYSIS_VERSION = 2;
export const PUZZLE_TTL_DAYS = 60;
const DEFAULT_SIZE_MM = 15;

export function dataDir() {
  const dir = process.env.DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
  fs.mkdirSync(path.join(dir, 'puzzles'), { recursive: true });
  return dir;
}

export const isValidId = (id) => /^[a-z0-9]{10}$/.test(id);

export function puzzleDir(id) {
  if (!isValidId(id)) throw Object.assign(new Error('Invalid puzzle id'), { status: 400 });
  return path.join(dataDir(), 'puzzles', id);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function exists(id) {
  return isValidId(id) && fs.existsSync(path.join(puzzleDir(id), 'meta.json'));
}

export function createPuzzle(name) {
  cleanupOld();
  let id;
  do {
    id = Array.from(crypto.randomBytes(10), (b) => 'abcdefghijkmnopqrstuvwxyz23456789'[b % 33]).join('');
  } while (fs.existsSync(path.join(dataDir(), 'puzzles', id)));
  fs.mkdirSync(path.join(puzzleDir(id), 'pieces'), { recursive: true });
  writeJson(path.join(puzzleDir(id), 'meta.json'), { id, name: name.slice(0, 80), created: Math.floor(Date.now() / 1000), nextPiece: 1 });
  return id;
}

function cleanupOld() {
  const root = path.join(dataDir(), 'puzzles');
  const limit = Date.now() - PUZZLE_TTL_DAYS * 86400e3;
  for (const id of fs.readdirSync(root)) {
    try {
      if (fs.statSync(path.join(root, id)).mtimeMs < limit) fs.rmSync(path.join(root, id), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function touch(id) {
  const now = new Date();
  try {
    fs.utimesSync(puzzleDir(id), now, now);
  } catch {
    // ignore
  }
}

/** Serializes read-modify-write sections per puzzle (one Node process serves everything). */
const locks = new Map();
export async function withLock(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  let release;
  const current = new Promise((r) => (release = r));
  locks.set(id, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === current) locks.delete(id);
  }
}

export function meta(id) {
  return readJson(path.join(puzzleDir(id), 'meta.json'));
}

export function saveMeta(id, data) {
  writeJson(path.join(puzzleDir(id), 'meta.json'), data);
}

const piecesDir = (id) => path.join(puzzleDir(id), 'pieces');

/** All piece summaries keyed by index; migrates summaries from older versions on the fly. */
export function summaries(id) {
  const out = new Map();
  for (const file of fs.readdirSync(piecesDir(id))) {
    const m = file.match(/^(\d+)\.json$/);
    if (!m) continue;
    let summary = readJson(path.join(piecesDir(id), file));
    if (!summary || summary.index === undefined) continue;
    if (!summary.pending && summary.version !== ANALYSIS_VERSION) summary = migrate(id, summary);
    out.set(summary.index, summary);
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

/** Pieces from the PHP version: re-analyze from the stored contour. */
function migrate(id, old) {
  const contour = readJson(path.join(piecesDir(id), `${old.index}_contour.json`));
  if (!Array.isArray(contour)) {
    return writeSummary(id, { index: old.index, label: old.label ?? String(old.index), created: old.created, ok: false, error: 'Scanned with an old version – please rescan.', version: ANALYSIS_VERSION });
  }
  return savePiece(id, old.index, { label: old.label ?? String(old.index), contour, sizeMm: old.sizeMm, quality: old.quality, created: old.created });
}

function writeSummary(id, summary) {
  writeJson(path.join(piecesDir(id), `${summary.index}.json`), summary);
  return summary;
}

/** Analyzes a contour and stores the piece; returns its summary. */
export function savePiece(id, index, { label, contour, sizeMm, quality, created }) {
  const size = sizeMm || DEFAULT_SIZE_MM;
  const mm = contour.map(([x, y]) => [(x * size) / 1000, (y * size) / 1000]);
  const analysis = analyzePiece(mm);
  const { sides, ...display } = analysis;
  writeJson(path.join(piecesDir(id), `${index}_contour.json`), contour);
  if (sides) writeJson(path.join(piecesDir(id), `${index}_sides.json`), sides);
  else fs.rmSync(path.join(piecesDir(id), `${index}_sides.json`), { force: true });
  return writeSummary(id, {
    index,
    label,
    created: created || Math.floor(Date.now() / 1000),
    quality: quality || {},
    measured: Boolean(sizeMm),
    version: ANALYSIS_VERSION,
    ...display,
  });
}

/** Pieces with their side descriptors, for matching and solving. */
export function analyzedPieces(id) {
  const out = new Map();
  for (const [index, summary] of summaries(id)) {
    if (!summary.ok) continue;
    const sides = readJson(path.join(piecesDir(id), `${index}_sides.json`));
    if (sides) out.set(index, { ...summary, sides });
  }
  return out;
}

export function reservePiece(id, label) {
  const m = meta(id);
  const index = m.nextPiece++;
  saveMeta(id, m);
  writeSummary(id, { index, label, ok: false, pending: true });
  return index;
}

export function deletePiece(id, index) {
  for (const suffix of ['.json', '_contour.json', '_sides.json']) fs.rmSync(path.join(piecesDir(id), `${index}${suffix}`), { force: true });
}

export function contourOf(id, index) {
  return readJson(path.join(piecesDir(id), `${index}_contour.json`));
}

export function updateSummary(id, index, changes) {
  const summary = readJson(path.join(piecesDir(id), `${index}.json`));
  return writeSummary(id, { ...summary, ...changes });
}

export function fingerprint(indexes) {
  return crypto.createHash('md5').update([...indexes].sort((a, b) => a - b).join(',')).digest('hex');
}

export function nextLabel(all) {
  let max = 0;
  for (const s of all.values()) if (/^\d+$/.test(String(s.label ?? ''))) max = Math.max(max, Number(s.label));
  return String(max + 1);
}

export const file = (id, name) => path.join(puzzleDir(id), name);
