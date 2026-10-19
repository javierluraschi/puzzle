// HTTP server: the single page app from public/ and the JSON API under /api/.
// Run: node server/index.js   (PORT, DATA_DIR)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as store from './store.js';
import { candidatesFor, confidence, shapeDifference } from './match.js';
import { currentUser, handleAuth } from './auth.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const MAX_PIECES = 1500;
const MAX_BODY = 4 * 1024 * 1024;
// mean side difference (mm, for a ~15 mm piece) below which a new scan is flagged as already scanned
const DUPLICATE_MM = 0.1;
const HALF_CONFIDENCE_MM = 0.12;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function serveStatic(req, res, pathname) {
  let file = path.resolve(PUBLIC, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const stat = fs.statSync(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', etag, 'content-length': stat.size });
  fs.createReadStream(file).pipe(res);
}

function cleanLabel(value) {
  const label = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!label || label.length > 24) throw new HttpError(400, 'A label must have 1 to 24 characters');
  return label;
}

function validateContour(contour) {
  if (!Array.isArray(contour) || contour.length < 100 || contour.length > 5000) throw new HttpError(400, 'contour must have 100 to 5000 points');
  for (const p of contour) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => Number.isFinite(v) && Math.abs(v) < 3000)) throw new HttpError(400, 'contour points must be [x, y] numbers');
  }
  return contour;
}

function labelOwner(all, label, except = null) {
  for (const [index, s] of all) if (index !== except && String(s.label ?? '').toLowerCase() === label.toLowerCase()) return index;
  return null;
}

// --- solving ----------------------------------------------------------------------------------

const running = new Map();

function solveStatus(id) {
  const status = store.readJson(store.file(id, 'status.json'), { state: 'idle' });
  // a solve that was interrupted by a restart
  if ((status.state === 'running' || status.state === 'queued') && !running.has(id)) return { ...status, state: 'failed', message: 'The solver stopped unexpectedly. Please try again.' };
  return status;
}

function startSolve(id) {
  if (running.has(id)) return;
  store.writeJson(store.file(id, 'status.json'), { state: 'queued', message: 'Starting solver…', started: Math.floor(Date.now() / 1000), updated: Math.floor(Date.now() / 1000) });
  const worker = new Worker(new URL('./solve-worker.js', import.meta.url), { workerData: { id } });
  running.set(id, worker);
  const done = () => running.delete(id);
  worker.on('exit', done);
  worker.on('error', (error) => {
    console.error('solver', id, error);
    store.writeJson(store.file(id, 'status.json'), { state: 'failed', message: error.message, updated: Math.floor(Date.now() / 1000) });
    done();
  });
}

// --- account ----------------------------------------------------------------------------------

/** GET /me, POST /me/puzzles { ids } (save puzzles to the account), DELETE /me/puzzles/<id>. */
async function account(req, res, route) {
  const user = currentUser(req);
  if (req.method === 'GET' && route === '/me') {
    if (!user) return send(res, 200, { user: null });
    return send(res, 200, { user: { name: user.name, email: user.email }, puzzles: store.userPuzzles(user) });
  }
  if (!user) throw new HttpError(401, 'Please sign in first');
  if (req.method === 'POST' && route === '/me/puzzles') {
    const ids = (await readBody(req)).ids;
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => typeof id === 'string')) throw new HttpError(400, 'ids must be a list of puzzle ids');
    const result = await store.addUserPuzzles(user, [...new Set(ids)]);
    return send(res, 200, { ...result, puzzles: store.userPuzzles(user) });
  }
  const m = route.match(/^\/me\/puzzles\/([a-z0-9]{10})$/);
  if (req.method === 'DELETE' && m) {
    await store.removeUserPuzzle(user, m[1]);
    return send(res, 200, { puzzles: store.userPuzzles(user) });
  }
  throw new HttpError(404, 'Not found');
}

// --- API --------------------------------------------------------------------------------------

function puzzleResponse(id) {
  const m = store.meta(id);
  const all = store.summaries(id);
  return { id, name: m.name, created: m.created, nextLabel: store.nextLabel(all), pieces: [...all.values()], solve: solveStatus(id) };
}

async function api(req, res, route) {
  const method = req.method;
  if (method === 'GET' && route === '/health') return send(res, 200, { ok: true });

  if (route === '/me' || route.startsWith('/me/')) return account(req, res, route);

  if (method === 'POST' && route === '/puzzles') {
    const body = await readBody(req);
    const id = store.createPuzzle(String(body.name ?? '').trim() || 'My puzzle');
    const user = currentUser(req);
    if (user) await store.addUserPuzzles(user, [id]);
    return send(res, 201, puzzleResponse(id));
  }

  const m = route.match(/^\/puzzles\/([a-z0-9]{10})(\/.*)?$/);
  if (!m || !store.exists(m[1])) throw new HttpError(404, 'Puzzle not found');
  const id = m[1];
  const sub = m[2] || '';
  store.touch(id);

  if (method === 'GET' && sub === '') return send(res, 200, puzzleResponse(id));

  if (method === 'PATCH' && sub === '') {
    const body = await readBody(req);
    await store.withLock(id, () => {
      const meta = store.meta(id);
      if (body.name) meta.name = String(body.name).trim().slice(0, 80) || meta.name;
      store.saveMeta(id, meta);
    });
    return send(res, 200, puzzleResponse(id));
  }

  if (method === 'GET' && sub === '/export') {
    const pieces = [...store.summaries(id).values()].filter((s) => !s.pending).map((s) => ({
      label: s.label, contour: store.contourOf(id, s.index), sizeMm: s.sizeMm ?? null, measured: s.measured ?? false, kind: s.kind ?? null, sides: s.directions ?? null, quality: s.quality ?? null,
    }));
    res.setHeader('content-disposition', `attachment; filename="puzzle-${id}.json"`);
    return send(res, 200, { format: 'jigsaw-catalog/2', units: 'contour centered, sqrt(area) = 1000 units; sizeMm = sqrt(area) in mm', name: store.meta(id).name, pieces });
  }

  if (method === 'POST' && sub === '/pieces') {
    const body = await readBody(req);
    const label = cleanLabel(body.label);
    const contour = validateContour(body.contour);
    const sizeMm = Number.isFinite(body.sizeMm) && body.sizeMm > 3 && body.sizeMm < 100 ? body.sizeMm : null;
    const quality = body.quality && typeof body.quality === 'object' ? body.quality : {};
    const replace = Number.isInteger(body.replace) ? body.replace : null;

    const index = await store.withLock(id, () => {
      const all = store.summaries(id);
      const owner = labelOwner(all, label, replace);
      if (owner !== null) throw new HttpError(409, `Label "${label}" is already used`, { index: owner });
      if (replace !== null) {
        if (!all.has(replace)) throw new HttpError(404, 'Piece to replace not found');
        return replace;
      }
      if (all.size >= MAX_PIECES) throw new HttpError(400, `A puzzle can have at most ${MAX_PIECES} pieces`);
      return store.reservePiece(id, label);
    });
    const summary = store.savePiece(id, index, { label, contour, sizeMm, quality });

    if (summary.ok) {
      // already scanned? compare with every other piece
      const pieces = store.analyzedPieces(id);
      const me = pieces.get(index);
      let best = null;
      for (const [j, other] of pieces) {
        if (j === index) continue;
        const d = shapeDifference(me, other);
        if (d < (best?.d ?? Infinity)) best = { j, d, label: other.label };
      }
      const limit = DUPLICATE_MM * (summary.sizeMm / 15);
      if (best && best.d < limit) {
        summary.possibleDuplicate = { index: best.j, label: best.label, differenceMm: Math.round(best.d * 1000) / 1000 };
        store.updateSummary(id, index, { possibleDuplicate: summary.possibleDuplicate });
      }
    }
    return send(res, replace !== null ? 200 : 201, { ...summary, nextLabel: store.nextLabel(store.summaries(id)) });
  }

  let pm = sub.match(/^\/pieces\/(\d+)$/);
  if (pm) {
    const index = Number(pm[1]);
    const all = store.summaries(id);
    if (!all.has(index)) throw new HttpError(404, 'Piece not found');
    if (method === 'GET') return send(res, 200, all.get(index));
    if (method === 'DELETE') {
      store.deletePiece(id, index);
      return send(res, 200, { deleted: index, nextLabel: store.nextLabel(store.summaries(id)) });
    }
    if (method === 'PATCH') {
      const label = cleanLabel((await readBody(req)).label);
      const summary = await store.withLock(id, () => {
        const owner = labelOwner(store.summaries(id), label, index);
        if (owner !== null) throw new HttpError(409, `Label "${label}" is already used`, { index: owner });
        return store.updateSummary(id, index, { label });
      });
      return send(res, 200, summary);
    }
  }

  pm = sub.match(/^\/pieces\/(\d+)\/matches$/);
  if (method === 'GET' && pm) {
    const index = Number(pm[1]);
    const pieces = store.analyzedPieces(id);
    if (!pieces.has(index)) throw new HttpError(404, 'Piece was not analyzed successfully');
    const cache = store.readJson(store.file(id, 'matches.json'));
    let sides;
    let typicalOffset = 0;
    if (cache && cache.fingerprint === store.fingerprint(pieces.keys())) {
      const table = new Map(cache.table);
      sides = [0, 1, 2, 3].map((s) => table.get(`${index}_${s}`) || []);
      typicalOffset = cache.typicalOffset;
    } else {
      sides = candidatesFor(pieces, index, { typicalOffset: cache?.typicalOffset ?? null });
    }
    const sizes = [...pieces.values()].map((p) => p.sizeMm).sort((a, b) => a - b);
    const half = HALF_CONFIDENCE_MM * (sizes[Math.floor(sizes.length / 2)] / 15);
    return send(res, 200, {
      piece: index,
      typicalOffset,
      sides: sides.map((list, side) => ({ side, candidates: list.map((c) => ({ piece: c.piece, side: c.side, scoreMm: c.score, probability: confidence(c.score, half) })) })),
    });
  }

  if (method === 'POST' && sub === '/solve') {
    if (!running.has(id)) startSolve(id);
    return send(res, 202, solveStatus(id));
  }

  if (method === 'GET' && sub === '/solution') {
    // solutions of the PHP version use another side numbering: solve again
    let solution = store.readJson(store.file(id, 'solution.json'));
    if (solution?.version !== 2) solution = null;
    if (solution) solution.stale = solution.fingerprint !== store.fingerprint(store.analyzedPieces(id).keys());
    return send(res, 200, { status: solveStatus(id), solution });
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname.startsWith('/auth/')) {
      if (!(await handleAuth(req, res, pathname, url, store.rememberUser))) throw new HttpError(404, 'Not found');
    } else if (pathname.startsWith('/api/')) await api(req, res, pathname.slice(4));
    else serveStatic(req, res, pathname);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : `Server error: ${error.message}`, ...(error.extra || {}) });
  }
});
server.listen(PORT, () => console.log(`listening on :${PORT}`));
