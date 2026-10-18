import { Scanner } from './scan/scanner.js';
import { pieceSvg, pairSvg, svgEl, pathData, placement, bodySize, SIDE_COLORS } from './shapes.js';

const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const SIDE_NAMES = { flat: 'flat edge', out: 'tab', in: 'blank', unknown: 'side' };

let state = null; // { id, name, pieces: Map(index -> summary), nextLabel, solve, solution, ... }

// --- tiny helpers ----------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, options = {}) {
  const init = { ...options };
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await fetch('/api' + path, init);
  const data = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: response.status, data });
  return data;
}

function percent(p) {
  return Math.round(p * 100) + '%';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortedPieces() {
  return [...state.pieces.values()].filter((p) => !p.pending).sort((a, b) => collator.compare(a.label ?? '', b.label ?? ''));
}

function labelOf(index) {
  return state.pieces.get(index)?.label ?? String(index);
}

function rememberPuzzle(id, name) {
  const list = JSON.parse(localStorage.getItem('puzzles') || '[]').filter((p) => p.id !== id);
  list.unshift({ id, name, time: Date.now() });
  localStorage.setItem('puzzles', JSON.stringify(list.slice(0, 20)));
}

function navigate(path) {
  history.pushState({}, '', path);
  route();
}

window.addEventListener('popstate', route);
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (link) {
    event.preventDefault();
    navigate(link.getAttribute('href'));
  }
});

// --- routing ---------------------------------------------------------------------------------

async function route() {
  const match = location.pathname.match(/^\/p\/([a-z0-9]{10})/);
  document.getElementById('puzzle-title').textContent = '';
  if (match) {
    await showPuzzle(match[1]);
  } else {
    state = null;
    showHome();
  }
}

function showHome() {
  app.replaceChildren(document.getElementById('home-template').content.cloneNode(true));
  document.getElementById('start-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get('name');
    const puzzle = await api('/puzzles', { method: 'POST', json: { name } });
    navigate('/p/' + puzzle.id);
  });
  document.getElementById('demo-button').addEventListener('click', async (event) => {
    event.target.disabled = true;
    const puzzle = await api('/puzzles', { method: 'POST', json: { name: 'Demo: cats (54 pieces)' } });
    sessionStorage.setItem('demo-' + puzzle.id, '1');
    navigate('/p/' + puzzle.id);
  });
  const list = JSON.parse(localStorage.getItem('puzzles') || '[]');
  if (list.length) {
    document.getElementById('recent').hidden = false;
    document.getElementById('recent-list').replaceChildren(...list.map((p) => h('li', {},
      h('a', { href: '/p/' + p.id, 'data-link': true }, p.name || p.id),
      h('span', { class: 'muted' }, ' · ' + new Date(p.time).toLocaleDateString()),
    )));
  }
}

async function showPuzzle(id) {
  let puzzle;
  try {
    puzzle = await api('/puzzles/' + id);
  } catch (error) {
    app.replaceChildren(h('section', { class: 'hero' }, h('h1', {}, 'Puzzle not found'), h('p', {}, error.message), h('a', { href: '/', 'data-link': true }, 'Back to start')));
    return;
  }
  state = {
    id,
    name: puzzle.name,
    pieces: new Map(puzzle.pieces.map((p) => [p.index, p])),
    nextLabel: puzzle.nextLabel,
    solve: puzzle.solve,
    solution: null,
    filter: 'all',
    groupRotations: new Map(),
  };
  rememberPuzzle(id, puzzle.name);
  document.getElementById('puzzle-title').textContent = puzzle.name;

  app.replaceChildren(document.getElementById('puzzle-template').content.cloneNode(true));
  for (const button of app.querySelectorAll('.tabs button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  document.getElementById('scan-button').addEventListener('click', () => openScanner());
  for (const button of app.querySelectorAll('#piece-filters button')) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      app.querySelectorAll('#piece-filters button').forEach((b) => b.classList.toggle('active', b === button));
      renderPieces();
    });
  }
  document.getElementById('export-link').href = `/api/puzzles/${id}/export`;
  document.getElementById('solve-button').addEventListener('click', startSolve);
  for (const control of ['show-numbers', 'show-links', 'show-singles', 'zoom']) {
    document.getElementById(control).addEventListener('input', renderSolution);
  }

  renderPieces();

  if (sessionStorage.getItem('demo-' + id)) {
    sessionStorage.removeItem('demo-' + id);
    await importDemo();
    return;
  }
  if (sortedPieces().length > 0) showTab(state.solve.state !== 'idle' ? 'solve' : 'catalog');
  if (state.solve.state !== 'idle') pollSolve();
}

function showTab(name) {
  for (const button of app.querySelectorAll('.tabs button')) button.classList.toggle('active', button.dataset.tab === name);
  for (const tab of app.querySelectorAll('.tab')) tab.hidden = tab.id !== 'tab-' + name;
  if (name === 'solve') renderSolution();
}

// --- demo -------------------------------------------------------------------------------------

/** Loads 54 contours traced from real scanned pieces, as if they had been scanned. */
async function importDemo() {
  showTab('catalog');
  const status = h('p', { class: 'hint' }, 'Loading the demo catalog…');
  document.getElementById('piece-grid').before(status);
  const demo = await (await fetch('/demo/cats.json')).json();
  const queue = [...demo.pieces];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const piece = queue.shift();
      const summary = await api(`/puzzles/${state.id}/pieces`, { method: 'POST', json: { label: piece.label, contour: piece.contour, scale: piece.scale, quality: { engine: 'demo' } } });
      state.pieces.set(summary.index, summary);
      state.nextLabel = summary.nextLabel;
      done++;
      status.textContent = `Analyzing demo pieces: ${done} of ${demo.pieces.length}…`;
      renderPieces();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  status.remove();
  showTab('solve');
  startSolve();
}

// --- step 1: scanning --------------------------------------------------------------------------

function openScanner({ replace = null, label = state.nextLabel } = {}) {
  // iOS asks for motion-sensor access (for the level indicator) only from a tap
  const permission = Scanner.requestMotionPermission();
  const host = document.getElementById('scanner-host');
  host.hidden = false;
  document.body.classList.add('scanning');
  let replacing = replace;
  const scanner = new Scanner(host, {
    label,
    onLabel: (value) => { if (replacing === null) state.nextLabel = value; },
    onScan: async ({ label: pieceLabel, contour, quality, sizeMm }) => {
      const summary = await api(`/puzzles/${state.id}/pieces`, { method: 'POST', json: { label: pieceLabel, contour, quality, sizeMm, replace: replacing } });
      state.nextLabel = summary.nextLabel;
      if (!summary.ok && replacing === null) {
        // keep the catalog clean: a failed scan is retaken, not stored
        await api(`/puzzles/${state.id}/pieces/${summary.index}`, { method: 'DELETE' }).catch(() => {});
      } else {
        state.pieces.set(summary.index, summary);
      }
      summary.replaced = replacing !== null;
      replacing = null;
      scanner.setCount(sortedPieces().filter((p) => p.ok).length);
      renderPieces();
      return summary;
    },
    onClose: () => {
      host.hidden = true;
      host.replaceChildren();
      document.body.classList.remove('scanning');
      renderPieces();
      if (sortedPieces().length) showTab('catalog');
    },
    renderResult: (summary, still) => renderScanResult(summary, still),
  });
  scanner.onRetake = async (summary) => {
    if (summary.replaced) {
      replacing = summary.index;
    } else if (summary.ok && state.pieces.has(summary.index)) {
      await api(`/puzzles/${state.id}/pieces/${summary.index}`, { method: 'DELETE' });
      state.pieces.delete(summary.index);
      renderPieces();
    }
  };
  scanner.setCount(sortedPieces().filter((p) => p.ok).length);
  permission.finally(() => scanner.start());
}

function renderScanResult(summary, still) {
  const info = h('div', { class: 'result-info' });
  if (summary.ok) {
    info.append(
      h('h3', {}, `#${summary.label} · ${summary.kind} piece`),
      h('p', { class: 'side-list' }, summary.directions.map((d, i) => h('span', { style: { color: SIDE_COLORS[d] } }, `${i + 1}: ${SIDE_NAMES[d]}`))),
    );
    if (summary.possibleDuplicate) {
      const dup = summary.possibleDuplicate;
      info.append(h('p', { class: 'warn' }, `Looks like #${dup.label}, which is already in the catalog.`),
        h('button', {
          class: 'danger small-button',
          onclick: async (event) => {
            await api(`/puzzles/${state.id}/pieces/${summary.index}`, { method: 'DELETE' });
            state.pieces.delete(summary.index);
            state.nextLabel = summary.label;
            event.target.replaceWith(h('span', { class: 'muted' }, 'Discarded.'));
            renderPieces();
          },
        }, 'Discard this scan'));
    }
  } else {
    info.append(h('h3', { class: 'error' }, `#${summary.label} not saved`), h('p', {}, summary.error || 'The analysis did not find four corners.'),
      h('p', { class: 'hint' }, 'Hold the phone flat, keep the whole piece in view and retake.'));
  }
  return h('div', { class: 'result-card' },
    h('div', { class: 'result-images' }, still, pieceSvg(summary, { zoom: 0.36, sides: true })),
    info);
}

// --- step 2: catalog ---------------------------------------------------------------------------

function renderPieces() {
  const grid = document.getElementById('piece-grid');
  if (!grid) return;
  const pieces = sortedPieces();
  const ok = pieces.filter((p) => p.ok);
  document.getElementById('piece-count').textContent = ok.length;
  const counts = { corner: 0, edge: 0, inner: 0 };
  ok.forEach((p) => counts[p.kind]++);
  document.getElementById('catalog-summary').textContent = ok.length
    ? `${ok.length} pieces · ${counts.corner} corners · ${counts.edge} edges · ${counts.inner} inner` : '';
  document.getElementById('scan-next-label').textContent = state.nextLabel;
  const visible = pieces.filter((p) => {
    if (state.filter === 'all') return true;
    if (state.filter === 'failed') return !p.ok;
    return p.ok && p.kind === state.filter;
  });
  grid.replaceChildren(...visible.map((piece) => h('button', { class: 'piece-card' + (piece.ok ? '' : ' failed'), onclick: () => showPieceDetails(piece.index) },
    pieceSvg(piece, { zoom: 0.17 }),
    h('span', { class: 'piece-number' }, piece.label),
    piece.ok ? h('span', { class: 'badge ' + piece.kind }, piece.kind) : h('span', { class: 'badge failed' }, 'failed'),
  )));
  if (!visible.length) grid.append(h('p', { class: 'muted' }, pieces.length ? 'No pieces in this category.' : 'No pieces yet – start scanning.'));
}

async function showPieceDetails(index) {
  const piece = state.pieces.get(index);
  const labelInput = h('input', { value: piece.label, maxlength: 24, class: 'label-input', 'aria-label': 'Label' });
  const saveLabel = async () => {
    const value = labelInput.value.trim();
    if (!value || value === piece.label) return;
    try {
      const summary = await api(`/puzzles/${state.id}/pieces/${index}`, { method: 'PATCH', json: { label: value } });
      state.pieces.set(index, summary);
      renderPieces();
      document.getElementById('dialog-title').textContent = `Piece #${summary.label}`;
    } catch (error) {
      alert(error.message);
      labelInput.value = piece.label;
    }
  };
  labelInput.addEventListener('change', saveLabel);
  const q = piece.quality || {};
  const qualityText = q.engine === 'demo' ? 'Demo piece (traced from a flatbed scan).'
    : q.frames ? `Fused from ${q.used} of ${q.frames} frames · frame-to-frame deviation ${q.deviation}% · ${q.pixelsPerPiece}px piece size · ${q.engine === 'sam' ? 'AI segmentation' : 'color segmentation'}${q.card ? ' · measured on the scan card' + (piece.sizeMm ? ` (${(piece.sizeMm).toFixed(1)} mm)` : '') : ' · size normalized (no scan card)'}` : '';

  const actions = h('div', { class: 'dialog-actions' },
    h('label', { class: 'label-edit' }, 'Label ', labelInput),
    h('button', { onclick: () => { dialog.close(); openScanner({ replace: index, label: piece.label }); } }, '📷 Rescan'),
    h('button', { onclick: () => openDialog(`Piece #${piece.label}: what the analyzer saw`, h('img', { class: 'debug-image', src: `/api/puzzles/${state.id}/files/pieces/${index}_debug.png?${piece.created || ''}` }), h('p', { class: 'hint' }, 'The silhouette rebuilt from the contour. Orange crosses mark the four detected corners; the side profiles are drawn on the left.')) }, '🔍 Analysis'),
    h('button', {
      class: 'danger',
      onclick: async () => {
        if (!confirm(`Remove piece #${piece.label}?`)) return;
        const result = await api(`/puzzles/${state.id}/pieces/${index}`, { method: 'DELETE' });
        state.pieces.delete(index);
        state.nextLabel = result.nextLabel;
        dialog.close();
        renderPieces();
      },
    }, 'Remove'),
  );

  if (!piece.ok) {
    openDialog(`Piece #${piece.label} could not be analyzed`, actions, h('p', {}, piece.error || 'Unknown error'), pieceSvg(piece, { zoom: 0.5 }));
    return;
  }

  const legend = h('p', { class: 'side-list' }, piece.directions.map((d, i) => h('span', { style: { color: SIDE_COLORS[d] } }, `${i + 1}: ${SIDE_NAMES[d]}`)));
  const body = h('div', { class: 'matches' }, h('p', { class: 'muted' }, 'Comparing shapes with all other pieces…'));
  openDialog(`Piece #${piece.label} · ${piece.kind}`, actions,
    h('div', { class: 'detail-shape' }, pieceSvg(piece, { zoom: 0.55, sides: true }), h('div', {}, legend, h('p', { class: 'muted small' }, qualityText))),
    h('h3', {}, 'What fits each side'), body);
  let result;
  try {
    result = await api(`/puzzles/${state.id}/pieces/${index}/matches`);
  } catch (error) {
    body.replaceChildren(h('p', {}, error.message));
    return;
  }
  body.replaceChildren(...result.sides.map(({ side, candidates }) => {
    const direction = piece.directions[side];
    const row = h('div', { class: 'match-row' }, h('div', { class: 'match-side' },
      pieceSvg(piece, { top: (side + 1) % 4, zoom: 0.16, highlight: side }),
      h('span', {}, `Side ${side + 1}`), h('span', { class: 'muted' }, SIDE_NAMES[direction])));
    const list = h('div', { class: 'match-list' });
    if (direction === 'flat') {
      list.append(h('p', { class: 'muted' }, 'Puzzle border – nothing attaches here.'));
    } else if (!candidates.length) {
      list.append(h('p', { class: 'muted' }, 'No plausible match among the pieces scanned so far.'));
    }
    for (const candidate of candidates.slice(0, 6)) {
      const other = state.pieces.get(candidate.piece);
      if (!other || !other.ok) continue;
      list.append(h('button', { class: 'match', onclick: () => showPieceDetails(candidate.piece) },
        pairSvg(piece, side, other, candidate.side, 0.12),
        h('span', { class: 'match-label' }, h('strong', {}, '#' + other.label), ' ', h('span', { class: 'prob', style: { '--p': candidate.probability } }, percent(candidate.probability)))));
    }
    row.append(list);
    return row;
  }));
}

function openDialog(title, ...content) {
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-body').replaceChildren(...content.filter(Boolean));
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

document.getElementById('dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

// --- step 3: solve -------------------------------------------------------------------------------

async function startSolve() {
  const okPieces = sortedPieces().filter((p) => p.ok).length;
  if (okPieces < 2) {
    alert('Scan at least two pieces first.');
    return;
  }
  state.solve = await api(`/puzzles/${state.id}/solve`, { method: 'POST' });
  renderSolveStatus();
  pollSolve();
}

let polling = false;
async function pollSolve() {
  if (polling) return;
  polling = true;
  const currentId = state.id;
  try {
    while (state && state.id === currentId) {
      const { status, solution } = await api(`/puzzles/${state.id}/solution`);
      state.solve = status;
      if (solution && (!state.solution || state.solution.created !== solution.created || state.solution.stale !== solution.stale)) {
        state.solution = solution;
        renderSolution();
      }
      renderSolveStatus();
      if (!['queued', 'running'].includes(status.state)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    polling = false;
  }
}

function renderSolveStatus() {
  const el = document.getElementById('solve-status');
  if (!el) return;
  const s = state.solve;
  const running = ['queued', 'running'].includes(s.state);
  document.getElementById('solve-button').disabled = running;
  document.getElementById('solve-button').textContent = state.solution ? 'Solve again' : 'Solve puzzle';
  const parts = [];
  if (running) {
    parts.push(h('span', { class: 'spinner' }), s.message || 'Working…');
    if (s.groups) parts.push(h('span', { class: 'muted' }, ` · ${s.groups} groups, biggest ${s.biggestGroup}/${s.pieces}`));
    parts.push(h('div', { class: 'muted small' }, `running for ${Math.round(Date.now() / 1000 - (s.started || Date.now() / 1000))}s – large puzzles take a few minutes; you can leave and come back.`));
  } else if (s.state === 'failed') {
    parts.push(h('span', { class: 'error' }, 'Solver failed: ' + (s.message || 'unknown error')));
  } else if (s.state === 'done') {
    parts.push(s.message);
  }
  if (state.solution?.stale && !running) parts.push(h('div', { class: 'warn small' }, 'Pieces were added or removed since this solution – solve again to include them.'));
  el.replaceChildren(...parts);
}

function renderSolution() {
  const container = document.getElementById('solution');
  if (!container) return;
  renderSolveStatus();
  const solution = state.solution;
  document.getElementById('solve-options').hidden = !solution;
  if (!solution) {
    container.replaceChildren(h('p', { class: 'hint' }, 'The solver compares every side with every other side and assembles pieces into groups. With all pieces of a puzzle you ideally get one big group; with some of them you get partial groups of pieces that belong together.'));
    return;
  }
  const zoom = Number(document.getElementById('zoom').value);
  const showNumbers = document.getElementById('show-numbers').checked;
  const showLinks = document.getElementById('show-links').checked;
  const showSingles = document.getElementById('show-singles').checked;
  const groups = solution.groups.filter((g) => g.placements.length > 1);
  const singles = solution.groups.filter((g) => g.placements.length === 1).map((g) => g.placements[0].piece);

  const nodes = [h('p', { class: 'muted' }, `${groups.length} group${groups.length === 1 ? '' : 's'} of connected pieces, ${singles.length} unplaced piece${singles.length === 1 ? '' : 's'}. Solved in ${solution.duration}s.`)];
  groups.forEach((group, i) => nodes.push(renderGroup(group, i, zoom, showNumbers, showLinks)));
  if (singles.length) {
    const singlePieces = singles.map((index) => state.pieces.get(index)).filter(Boolean);
    nodes.push(h('div', { class: 'group' }, h('div', { class: 'group-head' }, h('h3', {}, 'Not placed'), h('span', { class: 'muted' }, singles.length + ' pieces')),
      showSingles
        ? h('div', { class: 'piece-grid' }, singlePieces.map((piece) => h('button', { class: 'piece-card', onclick: () => showPieceDetails(piece.index) }, pieceSvg(piece, { zoom: 0.15 }), h('span', { class: 'piece-number' }, piece.label))))
        : h('p', { class: 'muted small' }, singlePieces.map((p) => '#' + p.label).join(', '))));
  }
  container.replaceChildren(...nodes);
}

function renderGroup(group, groupIndex, zoom, showNumbers, showLinks) {
  const rotation = state.groupRotations.get(groupIndex) || 0;
  const placements = group.placements.map((p) => rotatePlacement(p, rotation)).filter((p) => state.pieces.get(p.piece)?.ok);

  // column widths / row heights averaged over their pieces, like jigsawlutioner-cli
  const widths = new Map();
  const heights = new Map();
  for (const p of placements) {
    const [w, hh] = bodySize(state.pieces.get(p.piece), p.top);
    widths.set(p.x, [...(widths.get(p.x) || []), w]);
    heights.set(p.y, [...(heights.get(p.y) || []), hh]);
  }
  const offsets = (map) => {
    const keys = [...map.keys()];
    const min = Math.min(...keys);
    const max = Math.max(...keys);
    const result = new Map();
    let pos = 0;
    let last = 305;
    for (let k = min; k <= max; k++) {
      const values = map.get(k);
      const size = values ? values.reduce((a, b) => a + b, 0) / values.length : last;
      result.set(k, pos + size / 2);
      pos += size;
      last = size;
    }
    return { result, total: pos, min, max };
  };
  const cols = offsets(widths);
  const rows = offsets(heights);
  const margin = 120;
  const W = (cols.total + margin * 2) * zoom;
  const H = (rows.total + margin * 2) * zoom;

  const board = svgEl('svg', { class: 'board', width: W.toFixed(0), height: H.toFixed(0), viewBox: `0 0 ${W.toFixed(1)} ${H.toFixed(1)}` });
  const labels = svgEl('g', { class: 'board-labels' });
  for (const p of placements) {
    const piece = state.pieces.get(p.piece);
    const x = (cols.result.get(p.x) + margin) * zoom;
    const y = (rows.result.get(p.y) + margin) * zoom;
    const g = svgEl('g', { transform: placement(piece, p.top, zoom, x, y), class: 'board-piece' }, svgEl('path', { class: 'piece-fill', d: pathData(piece.outline) }));
    g.addEventListener('click', () => showPieceDetails(p.piece));
    board.append(g);
    if (showNumbers) {
      labels.append(svgEl('text', { x: x.toFixed(1), y: y.toFixed(1), class: 'piece-label', 'font-size': Math.max(7, Math.min(16, 70 * zoom)).toFixed(1) }, document.createTextNode(piece.label)));
    }
    if (showLinks) {
      p.links.forEach((probability, direction) => {
        if (probability === null || probability === undefined) return;
        const d = (direction + rotation * 3) % 4; // keep it on the same physical side after rotation
        const [dx, dy] = [[0, -0.5], [-0.5, 0], [0, 0.5], [0.5, 0]][d];
        const [w, hh] = bodySize(piece, p.top);
        const lx = x + dx * w * zoom;
        const ly = y + dy * hh * zoom;
        const hue = Math.round(probability * 120);
        labels.append(svgEl('rect', { x: (lx - 14).toFixed(1), y: (ly - 7).toFixed(1), width: 28, height: 14, rx: 3, fill: `hsla(${hue},80%,35%,0.9)` }));
        labels.append(svgEl('text', { x: lx.toFixed(1), y: (ly + 0.5).toFixed(1), class: 'link-label' }, document.createTextNode(percent(probability))));
      });
    }
  }
  board.append(labels);

  const grid = [];
  for (let y = rows.min; y <= rows.max; y++) {
    const cells = [];
    for (let x = cols.min; x <= cols.max; x++) {
      const p = placements.find((pl) => pl.x === x && pl.y === y);
      cells.push(p ? labelOf(p.piece) : '·');
    }
    grid.push(cells);
  }

  return h('div', { class: 'group' },
    h('div', { class: 'group-head' },
      h('h3', {}, groupIndex === 0 ? 'Biggest group' : `Group ${groupIndex + 1}`),
      h('span', { class: 'muted' }, `${placements.length} pieces · ${cols.max - cols.min + 1}×${rows.max - rows.min + 1}`),
      h('span', { class: 'spacer' }),
      h('button', { title: 'Rotate', onclick: () => { state.groupRotations.set(groupIndex, (rotation + 1) % 4); renderSolution(); } }, '⟳ rotate'),
      h('button', { onclick: () => openDialog('Layout grid', h('p', { class: 'hint' }, 'Piece labels by row, as shown in the group.'), h('table', { class: 'layout-grid' }, grid.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))) }, '▦ grid'),
    ),
    h('div', { class: 'board-scroll' }, board));
}

function rotatePlacement(p, times) {
  let { x, y, top } = p;
  for (let i = 0; i < times; i++) {
    // same as jigsawlutioner's Group::rotate (clockwise)
    top = (top + 1) % 4;
    [x, y] = [-y, x];
  }
  return { ...p, x, y, top };
}

route();
