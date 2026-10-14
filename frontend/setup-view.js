/* setup-view.js - the Standard workspace's "Set up analysis" step.
 *
 * Draws dataset tabs, an inline data grid with an uncertainty mode for each
 * measured quantity (Per point, Constant, None), and a live preview plot.
 *
 * The grid is a view. The values still live in the controls app.js and
 * multivariate.js already own (col-x, col-y, col-ex, col-ey, hist-samples,
 * hist-counts, hist-edges and the hidden multivariate columns), and every edit
 * is written back to them with an input event. Saving, autosave, fitting and
 * the Compact workspace therefore keep reading exactly what they read before.
 * The only new saved field is dataset.uncertainty_modes, which remembers the
 * mode chosen for each uncertainty column.
 *
 * The pure helpers at the top are exported for the node tests.
 */
'use strict';
(function (root) {

// ================================================================ pure helpers

const MODES = ['per-point', 'constant', 'none'];
const MODE_LABEL = { 'per-point': 'Per point', constant: 'Constant', none: 'None' };
const TYPE_LABEL = { xy: 'f(x)', histogram: 'Histogram', multivariate: 'Multivariate' };

function tokens(text) { return String(text ?? '').split(/[\s,;]+/).filter(t => t !== ''); }
function isNumber(s) { const t = String(s ?? '').trim(); return t !== '' && Number.isFinite(Number(t)); }

/** Column text -> one cell per row. Blank lines are kept so cells stay aligned;
 *  a line holding several values (an older "1, 2, 3" entry) becomes several rows. */
function splitCells(text) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  return s.replace(/\s+$/, '').split(/\r?\n/).flatMap(line => line.trim() ? tokens(line) : ['']);
}

/** Cells -> column text, one value per line. Empty when nothing is filled. */
function joinCells(cells, rowCount) {
  const out = cells.slice(0, rowCount).map(v => String(v ?? '').trim());
  return out.some(v => v !== '') ? out.join('\n') : '';
}

/** Which mode an uncertainty column is in. A stored choice wins while it still
 *  describes the text; otherwise the text decides (one value for several rows
 *  is Constant, none is None). A brand-new dataset gets the column's default. */
function resolveMode(stored, text, rowCount, fallback, datasetHasValues) {
  const n = tokens(text).length;
  if (stored === 'per-point') return stored;
  if (stored === 'constant' && n <= 1) return stored;
  if (stored === 'none' && n === 0) return stored;
  if (n === 0) return datasetHasValues ? 'none' : fallback;
  if (n === 1 && rowCount !== 1) return 'constant';
  return 'per-point';
}

/** One pasted line -> cells. Explicit delimiters keep empty cells in place. */
function splitRow(line) {
  const sep = line.includes('\t') ? '\t' : line.includes(',') ? ',' : line.includes(';') ? ';' : null;
  return sep ? line.split(sep).map(c => c.trim().replace(/^"(.*)"$/, '$1')) : line.trim().split(/\s+/);
}

/** Pasted or imported text -> {header, rows}. A first line with words in it,
 *  followed by numeric lines, is a header row. */
function parseBlock(text) {
  const rows = String(text ?? '').split(/\r?\n/).filter(l => l.trim() !== '').map(splitRow);
  let header = null;
  if (rows.length > 1 && rows[0].some(c => c !== '' && !isNumber(c)) && rows[1].some(isNumber)) header = rows.shift();
  return { header, rows };
}

/** Header names -> column indices, or null unless every header cell finds its own column.
 *  Understands "X", "x uncertainty", "u(x)", "dx", "σx", "sigma_x", "x err", "ex". */
function matchHeader(header, columns) {
  const norm = s => String(s ?? '').toLowerCase().replace(/[\s_\-]+/g, ' ').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const uncOf = h => {
    let m = h.match(/^(?:u|d|δ|σ|sigma|err|error|unc|uncertainty|e)\s*(.+)$/);
    if (m && !/^(x|y)$/.test(h)) return m[1].trim();
    m = h.match(/^(.+?)\s*(?:uncertainty|unc|err|error|errors|sigma|σ)$/);
    return m ? m[1].trim() : null;
  };
  const used = new Set(), out = [];
  for (const raw of header) {
    const h = norm(raw);
    let found = columns.findIndex((c, i) => !used.has(i) && c.kind !== 'unc' && norm(c.name ?? c.label) === h);
    if (found < 0) {
      const base = uncOf(h) ?? (/^e(x|y)$/.test(h) ? h.slice(1) : null);
      if (base !== null) found = columns.findIndex((c, i) => !used.has(i) && c.kind === 'unc' && norm(c.of) === base);
    }
    if (found < 0) return null;
    used.add(found); out.push(found);
  }
  return out;
}

/** Rows of a block -> which grid columns receive it. Pasting fills the editable
 *  columns from the start column in the order shown. A block wider than that
 *  also fills the uncertainty columns that are Constant or None, in display
 *  order, and returns them in `enable` so the caller can switch them to Per point. */
function pasteTargets(columns, editable, startCol, width, header) {
  if (header) {
    const mapped = matchHeader(header, columns);
    if (mapped) return { targets: mapped, enable: mapped.filter(c => !editable[c] && columns[c].kind === 'unc') };
  }
  const shown = columns.map((_, i) => i).filter(i => i >= startCol && !columns[i].readOnly && columns[i].kind !== 'derived');
  const open = shown.filter(i => editable[i]);
  if (width <= open.length) return { targets: open.slice(0, width), enable: [] };
  const targets = shown.slice(0, width);
  return { targets, enable: targets.filter(c => !editable[c]) };
}

/** Grid rows -> validation. `editable[c]` says whether a column holds per-row values. */
function validateRows(rows, columns, modes, consts) {
  const issues = [], bad = new Set();
  const rowHas = r => columns.some((c, i) => (c.kind === 'value' || (c.kind === 'unc' && modes[c.modeKey] === 'per-point')) && String(r[i] ?? '').trim() !== '');
  const filled = [];
  rows.forEach((r, i) => { if (rowHas(r)) filled.push(i); });
  const flag = (r, c, msg) => { bad.add(r + ':' + c); issues.push({ row: r, col: c, msg }); };
  for (const r of filled) {
    columns.forEach((col, c) => {
      const v = String(rows[r][c] ?? '').trim();
      if (col.kind === 'value') {
        if (v === '') { if (col.required !== false) flag(r, c, `Row ${r + 1} needs ${col.article || 'a'} ${col.name ?? col.label} value`); return; }
        if (!isNumber(v)) { flag(r, c, `Row ${r + 1}: “${v}” in ${col.name ?? col.label} is not a number`); return; }
        if (col.counts && (Number(v) < 0 || !Number.isInteger(Number(v)))) flag(r, c, `Row ${r + 1}: counts are whole numbers, zero or more`);
      } else if (col.kind === 'unc' && modes[col.modeKey] === 'per-point' && v !== '') {
        if (!isNumber(v)) flag(r, c, `Row ${r + 1}: “${v}” in ${col.label} is not a number`);
        else if (Number(v) < 0) flag(r, c, `Row ${r + 1}: ${col.label} is a size, so use zero or more`);
      }
    });
  }
  columns.forEach((col, c) => {
    if (col.kind !== 'unc') return;
    const mode = modes[col.modeKey];
    if (mode === 'per-point') {
      const missing = filled.filter(r => String(rows[r][c] ?? '').trim() === '');
      if (missing.length && missing.length < filled.length) {
        missing.forEach(r => bad.add(r + ':' + c));
        issues.push({ row: missing[0], col: c, partial: true, msg: `${col.label} is missing on ${missing.length === 1 ? 'row ' + (missing[0] + 1) : missing.length + ' rows'}. Fill every row, or choose Constant or None` });
      }
    } else if (mode === 'constant') {
      const v = String(consts[col.modeKey] ?? '').trim();
      if (v === '') issues.push({ row: -1, col: c, msg: `Enter the constant ${col.label}`, constant: true });
      else if (!isNumber(v)) issues.push({ row: -1, col: c, msg: `Constant ${col.label}: “${v}” is not a number`, constant: true });
      else if (Number(v) < 0) issues.push({ row: -1, col: c, msg: `Constant ${col.label} is a size, so use zero or more`, constant: true });
    }
  });
  issues.sort((a, b) => (a.row - b.row) || (a.col - b.col));
  return { filled, filledSet: new Set(filled), issues, bad };
}

/** Pre-binned rows (from, to, count) -> edges and counts, plus any problem. */
function binsFromRows(rows, filled) {
  const edges = [], counts = [], problems = [];
  filled.forEach((r, k) => {
    const from = String(rows[r][0] ?? '').trim(), to = String(rows[r][1] ?? '').trim();
    const nextFrom = k + 1 < filled.length ? String(rows[filled[k + 1]][0] ?? '').trim() : '';
    if (k === 0) edges.push(from);
    const end = to !== '' ? to : nextFrom;
    if (end === '') problems.push({ row: r, col: 1, msg: `Row ${r + 1} needs the value where its bin ends` });
    else if (to !== '' && nextFrom !== '' && isNumber(to) && isNumber(nextFrom) && Number(to) !== Number(nextFrom)) {
      problems.push({ row: filled[k + 1], col: 0, msg: `Row ${filled[k + 1] + 1} starts at ${nextFrom}, but the bin before it ends at ${to}. Bins must touch` });
    }
    if (isNumber(from) && isNumber(end) && Number(end) <= Number(from)) problems.push({ row: r, col: 1, msg: `Row ${r + 1}: a bin must end above where it starts` });
    edges.push(end);
    counts.push(String(rows[r][2] ?? '').trim());
  });
  return { edges, counts, problems };
}

/** The bins a samples histogram will get, following the backend's rule:
 *  explicit edges win; otherwise Bins (or the range width rounded up) over the range. */
function histogramFromSamples(values, { bins = '', min = '', max = '', edges = '' } = {}) {
  const custom = tokens(edges).map(Number);
  let e;
  if (custom.length >= 2 && custom.every(Number.isFinite) && custom.every((v, i) => !i || v > custom[i - 1])) e = custom;
  else {
    if (!values.length) return null;
    let lo = isNumber(min) ? Number(min) : Math.min(...values);
    let hi = isNumber(max) ? Number(max) : Math.max(...values);
    if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
    let n = isNumber(bins) && Number.isInteger(Number(bins)) && Number(bins) >= 1 ? Number(bins) : Math.max(1, Math.ceil(hi - lo));
    n = Math.min(n, 2000);
    e = Array.from({ length: n + 1 }, (_, i) => lo + (hi - lo) * i / n);
  }
  const counts = new Array(e.length - 1).fill(0);
  const last = e.length - 2;
  for (const v of values) {
    if (v < e[0] || v > e[e.length - 1]) continue;
    let lo = 0, hi = last;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (e[mid] <= v) lo = mid; else hi = mid - 1; }
    counts[lo]++;
  }
  return { edges: e, counts };
}

/** About `count` round tick values covering [min, max]. */
function niceTicks(min, max, count = 5) {
  if (!(max > min)) { const d = Math.abs(min) || 1; min -= d / 2; max += d / 2; }
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: out, step };
}
function fmtTick(v, step) {
  const digits = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1).replace('e+', 'e');
  return v.toFixed(digits);
}

/** The minimum width the grid needs before the preview has to move below it. */
function gridMinWidth(columns) {
  return 44 + columns.reduce((w, c) => w + (c.kind === 'unc' ? 160 : 120), 0);
}

const Core = { MODES, tokens, isNumber, splitCells, joinCells, resolveMode, splitRow, parseBlock, matchHeader, pasteTargets, validateRows, binsFromRows, histogramFromSamples, niceTicks, fmtTick, gridMinWidth };
if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
if (typeof document === 'undefined') return;

// ================================================================ the page

const $ = id => document.getElementById(id);
if (!$('setup-grid')) return;          // Compact and other pages have no setup grid
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MIN_ROWS = 8, SPARE_ROWS = 2, PREVIEW_WIDTH = 340, LAYOUT_GAP = 24, LAYOUT_SLACK = 16;

const active = () => (typeof datasets !== 'undefined' ? datasets[activeIdx] : null);
const fire = (el, type = 'input') => el && el.dispatchEvent(new Event(type, { bubbles: true }));
function setSource(el, text) {
  if (!el || el.value === text) return false;
  el.value = text; fire(el);
  return true;
}

// ---------------------------------------------------------------- column sources
// Each data type describes its columns and how to read and write their text.

function mvField(kind, i) { return $('multivariate-data')?.querySelector(`[data-mv="${kind}"][data-i="${i}"]`); }

const ADAPTERS = {
  xy: {
    columns(d) {
      const derived = !!d.derivedFrom;
      return [
        { id: 'x', label: 'X', kind: 'value', source: () => $('col-x') },
        { id: 'y', label: 'Y', kind: 'value', source: () => $('col-y'), readOnly: derived },
        { id: 'ex', label: 'X uncertainty', of: 'x', kind: 'unc', modeKey: 'ex', fallback: 'none', source: () => $('col-ex') },
        { id: 'ey', label: 'Y uncertainty', of: 'y', kind: 'unc', modeKey: 'ey', fallback: 'per-point', source: () => $('col-ey'), readOnly: derived },
      ];
    },
  },
  histogram: {
    columns() {
      if ($('hist-source').value === 'counts') return [
        { id: 'from', label: 'From', name: 'from', kind: 'value', article: 'a', binEdge: true },
        { id: 'to', label: 'To', name: 'to', kind: 'value', required: false, binEdge: true },
        { id: 'count', label: 'Count', name: 'count', kind: 'value', counts: true, source: () => $('hist-counts') },
      ];
      return [{ id: 'samples', label: 'Measurement', name: 'measurement', kind: 'value', source: () => $('hist-samples') }];
    },
  },
  multivariate: {
    columns(d) {
      const mv = d.mv || {};
      const n = mv.n || 1, m = mv.m || 1, cols = [];
      for (let i = 0; i < n; i++) cols.push({ id: 'in' + i, label: 'Input ' + (i + 1), name: mv.inNames?.[i] || 'x' + i, nameField: () => mvField('inName', i), kind: 'value', group: 'Inputs', source: () => mvField('inVal', i) });
      for (let k = 0; k < m; k++) cols.push({ id: 'out' + k, label: 'Output ' + (k + 1), name: mv.outNames?.[k] || 'y' + k, nameField: () => mvField('outName', k), kind: 'value', group: 'Outputs', source: () => mvField('outVal', k) });
      for (let i = 0; i < n; i++) cols.push({ id: 'ein' + i, label: (mv.inNames?.[i] || 'x' + i) + ' uncertainty', of: mv.inNames?.[i] || 'x' + i, kind: 'unc', modeKey: 'in' + i, fallback: 'none', source: () => mvField('inErr', i) });
      for (let k = 0; k < m; k++) cols.push({ id: 'eout' + k, label: (mv.outNames?.[k] || 'y' + k) + ' uncertainty', of: mv.outNames?.[k] || 'y' + k, kind: 'unc', modeKey: 'out' + k, fallback: 'per-point', source: () => mvField('outErr', k) });
      return cols;
    },
  },
};

// ---------------------------------------------------------------- view state

let view = null;        // the grid model for the active dataset
let refreshing = false;
let committing = 0;     // writes in progress: their input events must not rebuild the grid
let lastLayoutWidth = 0;

/** A fingerprint of everything the grid shows, to notice changes made elsewhere
 *  (another dataset, a loaded file, the table dialog, Analyze Data). */
function sourceSignature(d, type, columns) {
  const texts = columns.map(c => c.source?.()?.value ?? '');
  if (type === 'histogram' && $('hist-source').value === 'counts') texts.push($('hist-edges').value);
  return JSON.stringify([d.id, type, type === 'histogram' ? $('hist-source').value : '', columns.map(c => c.id + ':' + (c.name || '')), texts, !!d.derivedFrom]);
}

function datasetHasValues(d) {
  if (!d) return false;
  const any = s => tokens(s).length > 0;
  if (d.analysis_type === 'xy') return any($('col-x').value) || any($('col-y').value);
  if (d.analysis_type === 'histogram') return any($('hist-samples').value) || any($('hist-counts').value);
  if (d.analysis_type === 'multivariate') return (d.mv?.inVals || []).some(any) || (d.mv?.outVals || []).some(any);
  return false;
}

function buildView(d, type) {
  const columns = ADAPTERS[type].columns(d);
  const cells = columns.map(c => c.kind === 'unc' ? [] : splitCells(c.source?.()?.value));
  if (type === 'histogram' && $('hist-source').value === 'counts') {
    const e = tokens($('hist-edges').value);
    cells[0] = e.slice(0, Math.max(0, e.length - 1));
    cells[1] = e.slice(1);
  }
  let rowCount = Math.max(0, ...cells.map(c => c.length));
  const stored = d.uncertainty_modes || {};
  const hasValues = datasetHasValues(d);
  const modes = {}, consts = {};
  columns.forEach((c, i) => {
    if (c.kind !== 'unc') return;
    const text = c.source?.()?.value ?? '';
    modes[c.modeKey] = resolveMode(stored[c.modeKey], text, rowCount, c.fallback, hasValues);
    if (modes[c.modeKey] === 'constant') consts[c.modeKey] = tokens(text)[0] ?? '';
    else if (modes[c.modeKey] === 'per-point') { cells[i] = splitCells(text); rowCount = Math.max(rowCount, cells[i].length); }
  });
  const total = Math.max(MIN_ROWS, rowCount + SPARE_ROWS);
  const rows = Array.from({ length: total }, (_, r) => columns.map((_, c) => cells[c][r] ?? ''));
  return { id: d.id, type, columns, rows, modes, consts, signature: '', derived: !!d.derivedFrom };
}

const editableCol = (v, c) => {
  const col = v.columns[c];
  if (col.readOnly) return false;
  return col.kind === 'value' || (col.kind === 'unc' && v.modes[col.modeKey] === 'per-point');
};
const lastFilledRow = v => {
  for (let r = v.rows.length - 1; r >= 0; r--) if (v.rows[r].some((x, c) => String(x).trim() !== '' && (v.columns[c].kind === 'value' || editableCol(v, c)))) return r;
  return -1;
};

// ---------------------------------------------------------------- writing back

/** The grid -> the controls the rest of the app reads. */
function commit() {
  if (!view) return;
  committing++;
  try { writeSources(); } finally { committing--; }
  view.signature = sourceSignature(active(), view.type, view.columns);
  if (typeof autosave === 'function') autosave();
  scheduleSummary();
}
function writeSources() {
  const d = active();
  const rowCount = lastFilledRow(view) + 1;
  const col = i => view.rows.map(r => r[i]);
  if (view.type === 'histogram' && $('hist-source').value === 'counts') {
    const check = validateRows(view.rows, view.columns, view.modes, view.consts);
    const bins = binsFromRows(view.rows, check.filled);
    setSource($('hist-edges'), bins.edges.some(e => e !== '') ? bins.edges.join('\n') : '');
    setSource($('hist-counts'), joinCells(col(2), rowCount));
  } else {
    view.columns.forEach((c, i) => {
      if (c.readOnly) return;
      const el = c.source?.();
      if (!el) return;
      if (c.kind === 'value') setSource(el, joinCells(col(i), rowCount));
      else {
        const mode = view.modes[c.modeKey];
        setSource(el, mode === 'none' ? '' : mode === 'constant' ? String(view.consts[c.modeKey] ?? '').trim() : joinCells(col(i), rowCount));
      }
    });
  }
  if (d) {
    const modes = { ...(d.uncertainty_modes || {}) };
    view.columns.forEach(c => { if (c.kind === 'unc') modes[c.modeKey] = view.modes[c.modeKey]; });
    if (Object.keys(modes).length) d.uncertainty_modes = modes;
  }
}

// ---------------------------------------------------------------- grid rendering

function headerCell(c, i) {
  const col = view.columns[i];
  if (col.kind === 'unc') {
    const mode = view.modes[col.modeKey];
    const opts = MODES.map(m => `<option value="${m}"${m === mode ? ' selected' : ''}>${MODE_LABEL[m]}</option>`).join('');
    const constant = mode === 'constant'
      ? `<input type="text" class="unc-const${view.issues?.some(x => x.constant && x.col === i) ? ' is-bad' : ''}" data-const="${i}" inputmode="decimal" spellcheck="false" placeholder="value" value="${esc(view.consts[col.modeKey] ?? '')}" aria-label="${esc(col.label)}, one value for every row"${col.readOnly ? ' readonly' : ''}>`
      : '';
    return `<th scope="col" class="col-unc mode-${mode}"><span class="th-label">${esc(col.label)}</span>
      <select class="unc-mode" data-mode="${i}" aria-label="${esc(col.label)}"${col.readOnly ? ' disabled' : ''}>${opts}</select>${constant}</th>`;
  }
  if (col.nameField) {
    return `<th scope="col" class="col-value col-named"><span class="th-group">${esc(col.group)}</span>
      <input type="text" class="th-name" data-name="${i}" value="${esc(col.name)}" spellcheck="false" aria-label="Name of ${esc(col.label.toLowerCase())}"></th>`;
  }
  return `<th scope="col" class="col-value"><span class="th-label">${esc(col.label)}</span></th>`;
}

function bodyCell(r, c, firstEmpty) {
  const col = view.columns[c];
  const v = view.rows[r][c] ?? '';
  const filled = view.check?.filledSet.has(r);
  const bad = view.check?.bad.has(r + ':' + c);
  if (col.kind === 'unc' && view.modes[col.modeKey] !== 'per-point') {
    const mode = view.modes[col.modeKey];
    const text = !filled ? '' : mode === 'none' ? '—' : esc(view.consts[col.modeKey] ?? '');
    return `<td class="cell-off mode-${mode}" data-r="${r}" data-c="${c}">${text}</td>`;
  }
  const ph = firstEmpty ? (col.kind === 'unc' ? 'uncertainty' : (col.name ?? col.label)) : '';
  const label = `Row ${r + 1}, ${col.kind === 'unc' ? col.label : (col.name ?? col.label)}`;
  return `<td${bad ? ' class="is-bad"' : ''}><input type="text" inputmode="decimal" spellcheck="false" autocomplete="off" data-r="${r}" data-c="${c}" value="${esc(v)}" placeholder="${esc(ph)}" aria-label="${esc(label)}"${col.readOnly ? ' readonly title="Calculated data. Edit it in Analyze Data."' : ''}${bad ? ' aria-invalid="true"' : ''}></td>`;
}

function rowHtml(r, firstEmpty) {
  return `<tr data-row="${r}"><th scope="row" class="rownum">${r + 1}</th>${view.columns.map((_, c) => bodyCell(r, c, r === firstEmpty)).join('')}</tr>`;
}

function renderGrid() {
  const table = $('setup-grid');
  view.check = validateRows(view.rows, view.columns, view.modes, view.consts);
  view.issues = issuesFor(view);
  const firstEmpty = lastFilledRow(view) + 1;
  const groups = view.type === 'multivariate';
  table.className = 'setup-grid type-' + view.type + (groups ? ' has-names' : '');
  table.innerHTML = `<colgroup><col class="c-num">${view.columns.map(c => `<col class="c-${c.kind}">`).join('')}</colgroup>
    <thead><tr><th scope="col" class="rownum">#</th>${view.columns.map(headerCell).join('')}</tr></thead>
    <tbody>${view.rows.map((_, r) => rowHtml(r, firstEmpty)).join('')}</tbody>`;
}

/** Repaint one row's derived cells and error marks after an edit, without
 *  rebuilding the inputs (rebuilding would steal focus mid-typing). */
function repaintRows() {
  view.check = validateRows(view.rows, view.columns, view.modes, view.consts);
  view.issues = issuesFor(view);
  const firstEmpty = lastFilledRow(view) + 1;
  const tbody = $('setup-grid').tBodies[0];
  [...tbody.rows].forEach((tr, r) => {
    [...tr.cells].slice(1).forEach((td, c) => {
      const col = view.columns[c];
      if (col.kind === 'unc' && view.modes[col.modeKey] !== 'per-point') {
        const filled = view.check.filledSet.has(r);
        const text = !filled ? '' : view.modes[col.modeKey] === 'none' ? '—' : (view.consts[col.modeKey] ?? '');
        if (td.textContent !== text) td.textContent = text;
        return;
      }
      const bad = view.check.bad.has(r + ':' + c);
      td.classList.toggle('is-bad', bad);
      const input = td.firstElementChild;
      if (!input) return;
      if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      input.placeholder = r === firstEmpty ? (col.kind === 'unc' ? 'uncertainty' : (col.name ?? col.label)) : '';
    });
  });
  for (const input of $('setup-grid').querySelectorAll('.unc-const')) {
    input.classList.toggle('is-bad', view.issues.some(x => x.constant && x.col === +input.dataset.const));
  }
}

function ensureSpareRows() {
  const want = Math.max(MIN_ROWS, lastFilledRow(view) + 1 + SPARE_ROWS);
  if (view.rows.length >= want) return false;
  const tbody = $('setup-grid').tBodies[0];
  while (view.rows.length < want) {
    view.rows.push(view.columns.map(() => ''));
    tbody.insertAdjacentHTML('beforeend', rowHtml(view.rows.length - 1, -1));
  }
  return true;
}

function addRows(k = 10) {
  if (!view) return;
  const tbody = $('setup-grid').tBodies[0];
  for (let i = 0; i < k; i++) {
    view.rows.push(view.columns.map(() => ''));
    tbody.insertAdjacentHTML('beforeend', rowHtml(view.rows.length - 1, -1));
  }
  focusCell(lastFilledRow(view) + 1, firstEditable());
}

function firstEditable() { return view.columns.findIndex((_, c) => editableCol(view, c)); }
function focusCell(r, c) {
  const input = $('setup-grid').querySelector(`input[data-r="${r}"][data-c="${c}"]`);
  if (input) { input.focus(); input.select?.(); }
  return input;
}

// ---------------------------------------------------------------- validation summary

/** Grid validation plus the checks that need the whole type (pre-binned edges,
 *  matching multivariate rows). */
function issuesFor(v) {
  const list = [...v.check.issues];
  if (v.type === 'histogram' && $('hist-source').value === 'counts') {
    const problems = binsFromRows(v.rows, v.check.filled).problems;
    problems.forEach(p => v.check.bad.add(p.row + ':' + p.col));
    list.push(...problems);
    list.sort((a, b) => (a.row - b.row) || (a.col - b.col));
  }
  if (v.type === 'multivariate') {
    v.columns.forEach((c, i) => { if (c.nameField && !String(c.name).trim()) list.unshift({ row: -1, col: i, msg: `Name ${c.label.toLowerCase()}` }); });
  }
  return list;
}

function uncertaintySummary() {
  const parts = view.columns.filter(c => c.kind === 'unc').map(c => {
    const m = view.modes[c.modeKey];
    if (m === 'none') return null;
    if (m === 'constant') return `${c.label} ${String(view.consts[c.modeKey] ?? '').trim() || '(constant)'}`;
    const any = view.check.filled.some(r => String(view.rows[r][view.columns.indexOf(c)] ?? '').trim() !== '');
    return any ? `${c.label} per point` : null;
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no uncertainties';
}

function countWord(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

function renderSummary() {
  const status = $('setup-status');
  const d = active();
  const next = $('modern-next');
  if (!d || !d.analysis_type || !view) {
    status.textContent = 'No dataset yet · select a data type to start';
    status.className = 'setup-status';
    if (next) next.disabled = true;
    return;
  }
  if (next) next.disabled = false;
  const n = view.check.filled.length;
  const first = view.issues[0];
  let size, ready = n >= 2, enough = 'add at least two rows to fit';
  if (view.type === 'histogram') {
    const counts = $('hist-source').value === 'counts';
    size = countWord(n, counts ? 'bin' : 'measurement', counts ? 'bins' : 'measurements');
    ready = n >= 1; enough = counts ? 'add bin counts to fit' : 'add measurements to fit';
  } else if (view.type === 'multivariate') {
    size = countWord(n, 'row', 'rows');
  } else size = countWord(n, 'point', 'points');
  const parts = [`${d.name}: ${size}`];
  if (view.type !== 'histogram' && n) parts.push(uncertaintySummary());
  if (d.calculationError) parts.push(d.calculationError);
  else if (first) parts.push(first.msg + (view.issues.length > 1 ? ` (+${view.issues.length - 1} more)` : ''));
  else parts.push(ready ? 'ready to fit' : enough);
  status.textContent = parts.join(' · ');
  status.className = 'setup-status' + (first || d.calculationError ? ' has-issue' : ready ? ' is-ready' : '');
}

let summaryFrame = 0;
function scheduleSummary() {
  if (summaryFrame) return;
  summaryFrame = requestAnimationFrame(() => { summaryFrame = 0; renderSummary(); renderPreview(); });
}

// ---------------------------------------------------------------- chrome: tabs, type row, empty state

function renderTabs() {
  const tabs = $('setup-tabs');
  const typed = datasets.map((d, i) => ({ d, i })).filter(({ d }) => d.analysis_type);
  const mixed = new Set(typed.map(({ d }) => d.analysis_type)).size > 1;
  tabs.innerHTML = typed.map(({ d, i }) => {
    const on = i === activeIdx;
    return `<button type="button" role="tab" class="setup-tab" data-index="${i}" aria-selected="${on}" tabindex="${on ? 0 : -1}" title="${esc(d.name)} · ${TYPE_LABEL[d.analysis_type]}">${esc(d.name)}${mixed ? `<span class="tab-type">${TYPE_LABEL[d.analysis_type]}</span>` : ''}</button>`;
  }).join('');
  $('setup-tabs-row').hidden = !typed.length;
}

function renderTypeRow(d) {
  const type = d?.analysis_type || '';
  $('setup-type').value = type;
  $('setup-type').classList.toggle('is-empty', !type);
  $('setup-hist-source-field').hidden = type !== 'histogram';
  $('setup-mv-dims').hidden = type !== 'multivariate';
  if (type === 'multivariate' && d.mv) {
    if (document.activeElement !== $('setup-mv-n')) $('setup-mv-n').value = d.mv.n;
    if (document.activeElement !== $('setup-mv-m')) $('setup-mv-m').value = d.mv.m;
  }
  const counts = type === 'histogram' && $('hist-source').value === 'counts';
  // Before a type is chosen the card holds only the Data type menu.
  for (const id of ['setup-grid-wrap', 'setup-grid-foot']) $(id).hidden = !type;
  $('setup-unc-help').hidden = !type || type === 'histogram';
  $('setup-hist-options').hidden = type !== 'histogram';
  $('hist-edges-details').hidden = counts;
  if (type === 'histogram' && !counts && $('hist-edges').value.trim()) $('hist-edges-details').open = true;
  $('setup-hist-counts-help').hidden = !counts;
  $('setup-derived').hidden = !d?.derivedFrom;
  $('setup-paste-hint').textContent = type === 'multivariate'
    ? 'Paste columns straight from Excel or Sheets, in the order shown. A header row with these column names is matched by name.'
    : 'Paste columns straight from Excel or Sheets, in the order shown.';
}

function uniqueName() {
  for (let k = datasets.length + 1; ; k++) if (!datasets.some(d => d.name === 'Dataset ' + k)) return 'Dataset ' + k;
}

/** Choosing a type for an empty dataset sets it; a dataset that already holds
 *  data is never converted - the new type gets a dataset of its own. */
function chooseType(type) {
  if (!TYPE_LABEL[type]) return;
  syncActiveFromColumns();
  const d = datasets[activeIdx];
  if (d.analysis_type === type) return;
  if (!d.analysis_type || (!datasetHasValues(d) && !d.derivedFrom && !d.result)) {
    const fresh = newDataset(d.name, type);
    if (d.id) fresh.id = d.id;
    datasets[activeIdx] = fresh;
    showActiveInColumns();
    autosave();
    focusCell(0, firstEditable());
    return;
  }
  const name = uniqueName();
  datasets.push(newDataset(name, type));
  activeIdx = datasets.length - 1;
  showActiveInColumns();
  autosave();
  showMessage('info', `${d.name} keeps its ${TYPE_LABEL[d.analysis_type]} data. ${name} was added for the ${TYPE_LABEL[type]} data.`);
}

function newDatasetOfActiveType() {
  syncActiveFromColumns();
  const type = datasets[activeIdx].analysis_type || 'xy';
  datasets.push(newDataset(uniqueName(), type));
  activeIdx = datasets.length - 1;
  showActiveInColumns();
  autosave();
  focusCell(0, firstEditable());
}

// ---------------------------------------------------------------- pasting and importing

function showNote(text) {
  const note = $('setup-grid-note');
  note.textContent = text;
  note.hidden = !text;
}

/** A block of rows -> the grid, starting at (r0, c0). Returns the rows used, or 0. */
function placeBlock(block, r0, c0) {
  const width = Math.max(...block.rows.map(r => r.length));
  const editable = view.columns.map((_, c) => editableCol(view, c));
  const { targets, enable } = pasteTargets(view.columns, editable, c0, width, block.header);
  if (!targets.length) return 0;
  for (const c of enable) {
    const key = view.columns[c].modeKey;
    view.modes[key] = 'per-point';
  }
  while (view.rows.length < r0 + block.rows.length) view.rows.push(view.columns.map(() => ''));
  block.rows.forEach((cells, i) => targets.forEach((c, j) => { if (j < cells.length) view.rows[r0 + i][c] = cells[j]; }));
  while (view.rows.length < Math.max(MIN_ROWS, lastFilledRow(view) + 1 + SPARE_ROWS)) view.rows.push(view.columns.map(() => ''));
  const names = targets.map(c => view.columns[c].kind === 'unc' ? view.columns[c].label : (view.columns[c].name ?? view.columns[c].label));
  const switched = enable.length ? ` ${enable.map(c => view.columns[c].label).join(' and ')} switched to Per point.` : '';
  showNote(`Filled ${countWord(block.rows.length, 'row', 'rows')} into ${names.join(', ')}.${switched}`);
  return block.rows.length;
}

function onPaste(ev) {
  const input = ev.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.r === undefined || input.readOnly) return;
  const text = (ev.clipboardData || window.clipboardData)?.getData('text') ?? '';
  const block = parseBlock(text);
  if (!block.rows.length || (block.rows.length === 1 && block.rows[0].length === 1 && !block.header)) return;   // one value: normal paste
  ev.preventDefault();
  const r0 = +input.dataset.r, c0 = +input.dataset.c;
  if (!placeBlock(block, r0, c0)) return;
  commit();
  renderGrid();
  focusCell(r0, c0);
}

async function importFile(file) {
  if (!file || !view) return;
  const text = await file.text();
  const block = parseBlock(text);
  if (!block.rows.length) { showNote(`${file.name} has no rows to import.`); return; }
  if (view.derived) { showMessage('info', 'Calculated data is linked to Analyze Data. Import into a new dataset instead.'); return; }
  if (lastFilledRow(view) >= 0) {
    const ok = await askDialog({ title: 'Replace data', message: `Replace the data in ${active().name} with ${file.name}?`, accept: 'Replace data', destructive: true });
    if (!ok) return;
  }
  view.rows = [];
  const start = view.columns.findIndex(c => c.kind === 'value' && !c.readOnly);
  if (!placeBlock(block, 0, start)) return;
  commit();
  renderGrid();
}

// ---------------------------------------------------------------- grid events

function onGridInput(ev) {
  const t = ev.target;
  if (t.classList.contains('unc-const')) {
    view.consts[view.columns[+t.dataset.const].modeKey] = t.value;
    commit(); repaintRows();
    return;
  }
  if (t.classList.contains('th-name')) {
    const col = view.columns[+t.dataset.name];
    col.name = t.value;
    const field = col.nameField?.();
    if (field) { committing++; try { field.value = t.value; fire(field); } finally { committing--; } }
    renameUncertaintyLabels();
    view.signature = sourceSignature(active(), view.type, view.columns);
    scheduleSummary();
    return;
  }
  if (t.dataset.r === undefined) return;
  view.rows[+t.dataset.r][+t.dataset.c] = t.value;
  showNote('');
  ensureSpareRows();
  commit();
  repaintRows();
}

function renameUncertaintyLabels() {
  view.columns.forEach((c, i) => {
    if (c.kind !== 'unc') return;
    const target = view.columns.find(v => v.id === c.id.slice(1));
    if (!target) return;
    c.label = (target.name || target.label) + ' uncertainty';
    c.of = target.name;
    const th = $('setup-grid').tHead.rows[0].cells[i + 1];
    th.querySelector('.th-label').textContent = c.label;
    th.querySelector('select').setAttribute('aria-label', c.label);
  });
}

function onGridChange(ev) {
  const t = ev.target;
  if (!t.classList.contains('unc-mode')) return;
  const c = +t.dataset.mode, key = view.columns[c].modeKey, mode = t.value, previous = view.modes[key];
  if (mode === previous) return;
  const cells = view.rows.map(r => String(r[c] ?? '').trim());
  if (mode === 'constant' && !String(view.consts[key] ?? '').trim()) view.consts[key] = cells.find(v => v !== '') ?? '';
  if (mode === 'per-point' && previous === 'constant') {
    // Start every measured row from the constant; values typed earlier are kept.
    const value = String(view.consts[key] ?? '').trim();
    if (value) view.check.filled.forEach(r => { if (!cells[r]) view.rows[r][c] = value; });
  }
  view.modes[key] = mode;
  commit();
  renderGrid();
  const focus = mode === 'constant' ? $('setup-grid').querySelector(`[data-const="${c}"]`) : $('setup-grid').querySelector(`[data-mode="${c}"]`);
  focus?.focus();
}

function onGridKeydown(ev) {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || t.dataset.r === undefined) return;
  const r = +t.dataset.r, c = +t.dataset.c;
  let next = null;
  if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
    if (r + 1 >= view.rows.length) addRows(1);
    next = [r + 1, c];
  } else if (ev.key === 'ArrowUp' && r > 0) next = [r - 1, c];
  else if ((ev.key === 'ArrowRight' && t.selectionStart === t.value.length) || (ev.key === 'ArrowLeft' && t.selectionEnd === 0)) {
    const step = ev.key === 'ArrowRight' ? 1 : -1;
    for (let k = c + step; k >= 0 && k < view.columns.length; k += step) if (editableCol(view, k)) { next = [r, k]; break; }
  }
  if (next && focusCell(...next)) ev.preventDefault();
}

// ---------------------------------------------------------------- preview

function previewSize() {
  const box = $('setup-preview-plot');
  const w = Math.max(240, Math.round(box.clientWidth || 320));
  const stacked = $('setup-layout').classList.contains('is-stacked');
  return { w, h: stacked ? Math.max(210, Math.min(300, Math.round(w * 0.45))) : Math.round(Math.min(280, w * 0.8)) };
}

function frame({ w, h }, xr, yr, xLabel, yLabel) {
  const m = { l: 46, r: 12, t: 10, b: 38 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const X = v => m.l + (v - xr[0]) / (xr[1] - xr[0]) * pw;
  const Y = v => m.t + ph - (v - yr[0]) / (yr[1] - yr[0]) * ph;
  const xt = niceTicks(xr[0], xr[1], Math.max(3, Math.floor(pw / 55)));
  const yt = niceTicks(yr[0], yr[1], Math.max(3, Math.floor(ph / 42)));
  let s = '';
  for (const v of yt.ticks) if (v >= yr[0] && v <= yr[1]) s += `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmtTick(v, yt.step)}</text>`;
  for (const v of xt.ticks) if (v >= xr[0] && v <= xr[1]) s += `<line class="tickmark" x1="${X(v)}" x2="${X(v)}" y1="${m.t + ph}" y2="${m.t + ph + 4}"/><text class="tick" x="${X(v)}" y="${m.t + ph + 17}" text-anchor="middle">${fmtTick(v, xt.step)}</text>`;
  s += `<line class="axis" x1="${m.l}" x2="${m.l}" y1="${m.t}" y2="${m.t + ph}"/><line class="axis" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;
  s += `<text class="label" x="${m.l + pw / 2}" y="${h - 4}" text-anchor="middle">${esc(xLabel)}</text>`;
  s += `<text class="label" transform="translate(12 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>`;
  return { s, X, Y };
}

const pad = (lo, hi, f = 0.06) => { if (!(hi > lo)) { const d = Math.abs(lo) || 1; return [lo - d / 2, hi + d / 2]; } const d = (hi - lo) * f; return [lo - d, hi + d]; };

function scatterSvg(points, xLabel, yLabel) {
  const size = previewSize();
  const xs = points.flatMap(p => [p.x - (p.ex || 0), p.x + (p.ex || 0)]);
  const ys = points.flatMap(p => [p.y - (p.ey || 0), p.y + (p.ey || 0)]);
  const xr = pad(Math.min(...xs), Math.max(...xs)), yr = pad(Math.min(...ys), Math.max(...ys));
  const { s, X, Y } = frame(size, xr, yr, xLabel, yLabel);
  let marks = '';
  for (const p of points) {
    if (p.ey) marks += `<line class="err" x1="${X(p.x)}" x2="${X(p.x)}" y1="${Y(p.y - p.ey)}" y2="${Y(p.y + p.ey)}"/>`;
    if (p.ex) marks += `<line class="err" x1="${X(p.x - p.ex)}" x2="${X(p.x + p.ex)}" y1="${Y(p.y)}" y2="${Y(p.y)}"/>`;
    marks += `<circle class="pt" cx="${X(p.x)}" cy="${Y(p.y)}" r="3"/>`;
  }
  return `<svg viewBox="0 0 ${size.w} ${size.h}" width="${size.w}" height="${size.h}" role="img" aria-label="Preview of ${points.length} points">${s}${marks}</svg>`;
}

function histogramSvg(edges, counts, xLabel) {
  const size = previewSize();
  const density = counts.map((c, i) => c / (edges[i + 1] - edges[i]));
  const top = Math.max(...density, 0) || 1;
  const { s, X, Y } = frame(size, [edges[0], edges[edges.length - 1]], [0, top * 1.08], xLabel, 'Counts per unit X');
  let path = `M${X(edges[0])} ${Y(0)}`;
  density.forEach((v, i) => { path += ` L${X(edges[i])} ${Y(v)} L${X(edges[i + 1])} ${Y(v)}`; });
  path += ` L${X(edges[edges.length - 1])} ${Y(0)} Z`;
  return `<svg viewBox="0 0 ${size.w} ${size.h}" width="${size.w}" height="${size.h}" role="img" aria-label="Preview histogram with ${counts.length} bins">${s}<path class="bars" d="${path}"/></svg>`;
}

function emptyPreview(text) { return `<div class="preview-empty">${esc(text)}</div>`; }

function numericColumn(c, rows) { return rows.map(r => String(view.rows[r][c] ?? '').trim()).map(v => isNumber(v) ? Number(v) : NaN); }
function uncValues(c, rows) {
  const col = view.columns[c];
  if (!col) return rows.map(() => 0);
  const mode = view.modes[col.modeKey];
  if (mode === 'none') return rows.map(() => 0);
  if (mode === 'constant') { const v = Number(view.consts[col.modeKey]); return rows.map(() => (Number.isFinite(v) && v > 0 ? v : 0)); }
  return numericColumn(c, rows).map(v => (Number.isFinite(v) && v > 0 ? v : 0));
}

function renderPreview() {
  const box = $('setup-preview-plot');
  const count = $('setup-preview-count');
  const axes = $('setup-preview-axes');
  const d = active();
  axes.hidden = true;
  if (!view) { count.textContent = ''; box.innerHTML = emptyPreview('Select a data type, then type or paste your measurements. They are plotted here as you go.'); return; }
  const filled = view.check.filled;
  const xTitle = ($('x-title')?.value || '').trim(), yTitle = ($('y-title')?.value || '').trim();
  if (view.type === 'xy') {
    count.textContent = countWord(filled.length, 'point', 'points');
    const x = numericColumn(0, filled), y = numericColumn(1, filled), ex = uncValues(2, filled), ey = uncValues(3, filled);
    const pts = filled.map((_, i) => ({ x: x[i], y: y[i], ex: ex[i], ey: ey[i] })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    box.innerHTML = pts.length ? scatterSvg(pts, xTitle || 'X', yTitle || 'Y') : emptyPreview('Your points appear here as you add X and Y values.');
    return;
  }
  if (view.type === 'histogram') {
    let h = null;
    if ($('hist-source').value === 'counts') {
      const bins = binsFromRows(view.rows, filled);
      const e = bins.edges.map(Number), c = bins.counts.map(Number);
      count.textContent = countWord(filled.length, 'bin', 'bins');
      if (filled.length && e.every(Number.isFinite) && c.every(v => Number.isFinite(v) && v >= 0) && e.every((v, i) => !i || v > e[i - 1])) h = { edges: e, counts: c };
    } else {
      const values = numericColumn(0, filled).filter(Number.isFinite);
      count.textContent = countWord(values.length, 'measurement', 'measurements');
      h = histogramFromSamples(values, { bins: $('hist-bins').value, min: $('hist-min').value, max: $('hist-max').value, edges: $('hist-edges').value });
    }
    box.innerHTML = h && h.counts.length ? histogramSvg(h.edges, h.counts, xTitle || 'X') : emptyPreview('Your histogram appears here as you add values.');
    return;
  }
  // multivariate: one output against one input, chosen above the plot
  const ins = view.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.group === 'Inputs');
  const outs = view.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.group === 'Outputs');
  count.textContent = countWord(filled.length, 'row', 'rows');
  const fill = (sel, list) => {
    const keep = sel.value;
    sel.innerHTML = list.map(({ c, i }) => `<option value="${i}">${esc(c.name)}</option>`).join('');
    if (list.some(({ i }) => String(i) === keep)) sel.value = keep;
  };
  fill($('setup-preview-x'), ins); fill($('setup-preview-y'), outs);
  axes.hidden = ins.length < 2 && outs.length < 2;
  const xi = +$('setup-preview-x').value, yi = +$('setup-preview-y').value;
  const x = numericColumn(xi, filled), y = numericColumn(yi, filled);
  const ex = uncValues(view.columns.findIndex(c => c.id === 'e' + view.columns[xi].id), filled);
  const ey = uncValues(view.columns.findIndex(c => c.id === 'e' + view.columns[yi].id), filled);
  const pts = filled.map((_, i) => ({ x: x[i], y: y[i], ex: ex[i], ey: ey[i] })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  box.innerHTML = pts.length ? scatterSvg(pts, view.columns[xi].name, view.columns[yi].name) : emptyPreview('Your rows appear here as you add inputs and outputs.');
}

// ---------------------------------------------------------------- layout

/** Preview beside the grid when both fit, below it otherwise: on narrow
 *  windows, and for wide grids such as multivariate data with many columns. */
function layout() {
  const box = $('setup-layout');
  if (!box || $('step-data').hidden) return;
  const width = box.clientWidth;
  if (!width) return;
  const card = $('setup-card');
  const style = getComputedStyle(card);
  const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2;
  const need = (view ? gridMinWidth(view.columns) : 520) + chrome + LAYOUT_GAP + PREVIEW_WIDTH + LAYOUT_SLACK;
  const stacked = width < need;
  const changed = box.classList.contains('is-stacked') !== stacked;
  box.classList.toggle('is-stacked', stacked);
  if (changed || Math.abs(width - lastLayoutWidth) > 4) { lastLayoutWidth = width; renderPreview(); }
}

// ---------------------------------------------------------------- refresh

function refresh() {
  if (refreshing || committing || typeof datasets === 'undefined') return;
  refreshing = true;
  try {
    const d = active();
    renderTabs();
    renderTypeRow(d);
    const type = d?.analysis_type || '';
    if (!type) {
      view = null;
      $('setup-grid').innerHTML = '';
    } else {
      const columns = ADAPTERS[type].columns(d);
      const signature = sourceSignature(d, type, columns);
      if (!view || view.signature !== signature) {
        const focused = document.activeElement?.closest?.('#setup-grid') ? document.activeElement : null;
        view = buildView(d, type);
        view.signature = signature;
        renderGrid();
        if (focused?.dataset?.r !== undefined) focusCell(+focused.dataset.r, +focused.dataset.c);
      }
    }
    renderSummary();
    layout();
    renderPreview();
  } finally { refreshing = false; }
}

// ---------------------------------------------------------------- menus

function wireMenu(buttonId, menuId) {
  const button = $(buttonId), menu = $(menuId);
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', ev => {
    ev.stopPropagation();
    const open = menu.hidden;
    for (const other of document.querySelectorAll('.pop-menu')) if (other !== menu) other.hidden = true;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button:not(:disabled)')?.focus();
  });
  menu.addEventListener('click', close, true);          // items run their own handlers; the menu just closes
  menu.addEventListener('keydown', ev => {
    const items = [...menu.querySelectorAll('button:not(:disabled):not([hidden])')];
    const at = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') { close(); button.focus(); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); items[(at + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
  });
  document.addEventListener('click', ev => { if (!menu.hidden && !menu.contains(ev.target)) close(); });
  menu.addEventListener('focusout', ev => { if (!menu.contains(ev.relatedTarget) && ev.relatedTarget !== button) close(); });
}

// ---------------------------------------------------------------- wiring

function init() {
  wireMenu('doc-more', 'doc-more-menu');
  wireMenu('setup-examples-btn', 'setup-examples-menu');
  wireMenu('setup-dataset-more', 'setup-dataset-menu');
  for (const b of document.querySelectorAll('[data-example-key]')) b.addEventListener('click', () => loadExample(b.dataset.exampleKey));

  $('setup-type').addEventListener('change', ev => chooseType(ev.target.value));
  $('setup-new-dataset').addEventListener('click', newDatasetOfActiveType);

  const tabs = $('setup-tabs');
  tabs.addEventListener('click', ev => {
    const tab = ev.target.closest('[data-index]');
    if (tab) { setActiveDataset(+tab.dataset.index); $('setup-tabs').querySelector('[aria-selected="true"]')?.focus(); }
  });
  tabs.addEventListener('keydown', ev => {
    const list = [...tabs.querySelectorAll('[role="tab"]')];
    const at = list.indexOf(document.activeElement);
    if (at < 0) return;
    let k = null;
    if (ev.key === 'ArrowRight') k = (at + 1) % list.length;
    if (ev.key === 'ArrowLeft') k = (at + list.length - 1) % list.length;
    if (ev.key === 'Home') k = 0;
    if (ev.key === 'End') k = list.length - 1;
    if (k !== null) { ev.preventDefault(); list[k].click(); }
  });

  for (const id of ['setup-mv-n', 'setup-mv-m']) $(id).addEventListener('change', () => {
    const target = $(id === 'setup-mv-n' ? 'mv-n' : 'mv-m');
    if (!target) return;
    target.value = $(id).value;
    fire(target, 'change');
    refresh();
  });

  const grid = $('setup-grid');
  grid.addEventListener('input', onGridInput);
  grid.addEventListener('change', onGridChange);
  grid.addEventListener('keydown', onGridKeydown);
  grid.addEventListener('paste', onPaste);
  $('setup-add-rows').addEventListener('click', () => addRows(10));
  $('setup-import').addEventListener('click', () => $('setup-import-file').click());
  $('setup-import-file').addEventListener('change', ev => { importFile(ev.target.files[0]); ev.target.value = ''; });

  for (const id of ['hist-bins', 'hist-min', 'hist-max', 'hist-edges', 'x-title', 'y-title']) $(id)?.addEventListener('input', scheduleSummary);
  for (const id of ['setup-preview-x', 'setup-preview-y']) $(id).addEventListener('change', renderPreview);
  $('hist-source').addEventListener('change', refresh);

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => layout()).observe($('setup-layout'));
  else window.addEventListener('resize', layout);
  refresh();
}

/** Fitting refuses a Per point column with gaps: a lone value would otherwise
 *  be applied to every point. Called by the payload builders in app.js and
 *  multivariate.js for the dataset being fitted. */
function assertComplete(d) {
  if (!view || !d || view.id !== d.id) return;
  const issue = validateRows(view.rows, view.columns, view.modes, view.consts).issues.find(i => i.partial);
  if (issue) throw new Error(issue.msg + '.');
}

root.SetupView = { refresh, layout, assertComplete, Core };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})(typeof window !== 'undefined' ? window : globalThis);
