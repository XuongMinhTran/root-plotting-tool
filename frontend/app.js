/*
 * app.js — all the behaviour of index.html.
 *
 * Sections:
 *   1. helpers            element lookup, number formatting, downloads
 *   2. help pop-overs     the "?" buttons and their texts
 *   3. datasets           several independent (x, y, ex, ey) sets; the four
 *                         text boxes always show the "active" one
 *   4. data table         the spreadsheet-style editor dialog
 *   5. form <-> object    read the whole form into one object and back
 *   6. parameters         the parameter table, kept in sync with the comma lists
 *   7. backend            talk to the Flask server (/health, /fit)
 *   8. fit report         render the result, export it as text / CSV
 *   9. plot               load JSROOT, draw the ROOT canvas, export PNG, resizers
 *  10. documents          save / load JSON documents, autosave to localStorage
 *  11. menus & actions    menu bar, dialogs, built-in examples
 *  12. wiring             connect everything at start-up
 *
 * Plain JavaScript, loaded as an ordinary script (not a module) so the page
 * also works when opened straight from disk.
 */

'use strict';

// ================================================================ 1. helpers

const $ = (id) => document.getElementById(id);

const DEFAULT_BACKEND = 'http://localhost:8000';
const BACKEND_KEY = 'rootfit.backendUrl';
const LAYOUT_KEY = 'rootfit.layout';

/** Round `value` so that its uncertainty shows two significant figures,
 *  e.g. (1.97539, 0.045541) -> "1.975 ± 0.046". */
function fmtPair(value, error) {
  if (!Number.isFinite(value)) return String(value);
  if (!Number.isFinite(error) || error <= 0) return `${fmtNum(value)} ± ${fmtNum(error)}`;
  const digits = Math.max(0, 1 - Math.floor(Math.log10(error)));
  if (digits > 12) return `${value.toExponential(6)} ± ${error.toExponential(2)}`;
  return `${value.toFixed(digits)} ± ${error.toFixed(digits)}`;
}

function fmtNum(v, sig = 6) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(sig - 1);
  return String(parseFloat(v.toPrecision(sig)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = 'status-part' + (el.classList.contains('grow') ? ' grow' : '') + (kind ? ' ' + kind : '');
}

/** Show a message above the plot. kind = 'error' | 'warn' | 'info' | '' (hide). */
function showMessage(kind, text) {
  const box = $('message');
  if (!kind) { box.hidden = true; box.textContent = ''; return; }
  box.className = 'message ' + kind;
  box.textContent = text;
  box.hidden = false;
}

function downloadDataUrl(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadText(text, filename, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  downloadDataUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A safe file name from the document title (or graph title), e.g. "pendulum-lab-3". */
function fileBaseName() {
  const raw = ($('doc-title').value || $('graph-title').value || 'rootfit').trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'rootfit';
}

function storageGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* ignore */ } }
function storageRemove(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } }

// ================================================================ 2. help pop-overs

const HELP = {
  data: {
    title: 'Entering data',
    html: `
      <p>Each column holds one number per point. Paste straight from a spreadsheet: values separated by new lines,
      commas, tabs, semicolons or spaces are all accepted, and blank lines are ignored.</p>
      <p><b>Errors are optional.</b> Leave both error columns empty for an <em>unweighted</em> fit: every point counts
      the same, and the reported χ² is then in arbitrary units (its absolute value means nothing, only the shape of
      the fit does). With Y errors, each point is weighted by 1/σ<sub>y</sub>², which is what makes χ² and the parameter
      uncertainties meaningful.</p>
      <p><b>X errors</b> are folded in by ROOT's "effective variance" method: σ²<sub>eff</sub> = σ<sub>y</sub>² + (f′(x)·σ<sub>x</sub>)²,
      i.e. an uncertainty in x is turned into an equivalent uncertainty in y using the slope of the fitted curve.</p>
      <p><b>Several datasets</b> (x1 y1, x2 y2, …) can live in one document — use +, and switch with the selector.
      The fit runs on the dataset shown in the columns.</p>
      <p><b>Expand</b> opens a table where you can paste a whole block of columns at once, add or delete rows, and
      import a text file with a column mapping.</p>`,
  },
  formula: {
    title: 'Writing a fit function',
    html: `
      <p>The function is a ROOT <b>TFormula</b>. <code>x</code> is the independent variable and <code>[0]</code>,
      <code>[1]</code>, … are the parameters to be fitted. Arithmetic: <code>+ - * / ^</code> (use <code>^</code> or
      <code>pow(x,2)</code> for powers, not <code>**</code>).</p>
      <p>Functions: <code>exp log log10 sqrt pow abs sin cos tan asin acos atan sinh cosh tanh</code>, and
      <code>TMath::…</code> such as <code>TMath::Exp</code>, <code>TMath::Pi()</code>, <code>TMath::Landau(x,mpv,sigma)</code>,
      <code>TMath::Erf</code>.</p>
      <p><b>Named functions</b> save typing: <code>gaus</code> = [0]·exp(−½((x−[1])/[2])²), <code>expo</code> = exp([0]+[1]x),
      <code>landau</code>, <code>pol2</code> = [0]+[1]x+[2]x². They can be added with a parameter offset:
      <code>gaus(0)+pol1(3)</code> uses [0]–[2] for the peak and [3]–[4] for the line.</p>
      <p>Conditions work too: <code>x&lt;[2] ? [0]*x : [1]</code>.</p>
      <p>Examples: <code>[0]*exp(-x/[1])+[2]</code> (decay with background),
      <code>[0]*sin([1]*x+[2])*exp(-x/[3])</code> (damped oscillation),
      <code>[0]*pow(sin([1]*x)/([1]*x),2)</code> (single-slit).</p>
      <p>For safety the server only accepts this vocabulary; anything else is rejected with a message.</p>`,
  },
  guesses: {
    title: 'Why initial guesses matter',
    html: `
      <p>Minuit finds the χ² minimum by walking downhill from the starting point. For a straight line or a polynomial
      the χ² surface is a simple bowl, so any start works. For most other functions there are flat regions and
      false minima, and a bad start ends in nonsense (parameters stuck at 0, zero uncertainties, "did not converge").</p>
      <p>Without guesses every parameter starts at <b>0</b>. ROOT computes its own starting values only for a lone
      <code>gaus</code>, <code>expo</code>, <code>landau</code> or <code>polN</code> — not for sums like
      <code>gaus(0)+pol0(3)</code>.</p>
      <p>Read rough values off your data: a peak's height, position and width; a decay's starting value and the time
      it takes to drop by ⅔; an oscillation's amplitude and period (ω = 2π/T). Being within a factor of 2–3 is usually enough.</p>
      <p>Leave a slot empty (<code>1,,3</code>) to keep ROOT's default for that parameter.</p>`,
  },
  range: {
    title: 'Fit range',
    html: `
      <p>By default the function is fitted to every point. Give a range to use only the points with
      x<sub>min</sub> ≤ x ≤ x<sub>max</sub> — for instance to fit the linear part of a curve, or to exclude a region where
      your model does not apply. The curve is still drawn only over the fitted range, so you can see what was used.</p>
      <p>NDF changes accordingly: it is the number of points <em>inside</em> the range minus the number of parameters.</p>`,
  },
  plot: {
    title: 'Plot options',
    html: `
      <p><b>Log axes</b> are applied to the ROOT canvas; points with zero or negative values cannot be shown on a log axis.
      A straight line on a log-Y plot is an exponential; on log-log it is a power law.</p>
      <p><b>Grid</b> draws dotted lines at the major ticks.</p>
      <p><b>Panel under the plot.</b> <em>Residuals</em> show data − fit for every point, with the same error bar
      that entered χ² (so a point one error bar from the dashed zero line contributed 1 to χ²). <em>Pulls</em> divide
      by that error: for a good fit they scatter like a standard normal — about ⅔ within ±1, hardly any beyond ±3.
      Look for <em>patterns</em>: a bow, a wave or a drift in the residuals means the model is missing something,
      even when χ²/NDF looks acceptable.</p>`,
  },
  report: {
    title: 'Reading the fit report',
    html: `
      <p><b>Value ± uncertainty</b>: the best-fit parameter and its 1σ (68 %) uncertainty from the covariance matrix
      that Minuit builds at the minimum. Quoted to two significant figures on the uncertainty; the full-precision
      numbers are in the next columns.</p>
      <p><b>χ²</b> = Σ ((y<sub>i</sub> − f(x<sub>i</sub>)) / σ<sub>i</sub>)² — the sum of squared distances between data and
      curve, each measured in units of that point's error.</p>
      <p><b>NDF</b> (degrees of freedom) = number of fitted points − number of free parameters.</p>
      <p><b>χ²/NDF</b> is the headline number. Roughly 1 means the curve passes within the error bars as often as it
      should. Much larger than 1: either the model is wrong or the errors are underestimated. Much smaller than 1:
      the errors are probably overestimated (or the data were smoothed). Meaningless without Y errors.</p>
      <p><b>p-value</b> (ROOT's "Prob"): the probability of getting a χ² at least this large by chance if the model
      and the errors were right. Below ~0.05 is suspicious; astronomically small (1e-30) means "not this model".</p>
      <p><b>Status</b>: "converged" means Minuit reached a proper minimum and the uncertainties can be trusted.
      Other messages mean try better starting values, or that the model has parameters the data cannot pin down.</p>
      <p><b>Residual panel</b>: the lower plot shows data − fit (or pulls). Random scatter around the dashed zero line
      is what a correct model looks like; any shape (a bow, a wave, a trend) means the function is wrong or incomplete.</p>`,
  },
};

let helpOpen = null;

function showHelp(key, anchor) {
  const pop = $('help-pop');
  const h = HELP[key];
  if (!h) return;
  if (helpOpen === key && !pop.hidden) { hideHelp(); return; }
  pop.innerHTML = `<div class="help-title">${h.title}<button type="button" class="help-close" aria-label="Close">×</button></div><div class="help-body">${h.html}</div>`;
  pop.hidden = false;
  helpOpen = key;
  pop.querySelector('.help-close').addEventListener('click', hideHelp);
  // position: under the anchor if there is one, else centred
  const w = Math.min(420, window.innerWidth - 24);
  pop.style.width = w + 'px';
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6;
    pop.style.left = Math.max(12, left) + 'px';
    pop.style.top = top + 'px';
    // if it would run off the bottom, put it above the anchor instead
    const ph = pop.offsetHeight;
    if (top + ph > window.innerHeight - 12 && r.top - ph - 6 > 12) pop.style.top = (r.top - ph - 6) + 'px';
  } else {
    pop.style.left = Math.max(12, (window.innerWidth - w) / 2) + 'px';
    pop.style.top = '80px';
  }
}

function hideHelp() { $('help-pop').hidden = true; helpOpen = null; }

// ================================================================ 3. datasets

// ROOT's classic colours: kBlack, kRed, kBlue, kGreen+2, kMagenta+1, kOrange+7, kCyan+2, kBrown
const DATASET_COLORS = ['#000000', '#d62728', '#1f5fbf', '#2a8f3c', '#8e44ad', '#e08a00', '#17a2b8', '#7f4f24'];
const COLUMNS = ['x', 'y', 'ex', 'ey'];
const COLUMN_LABEL = { x: 'X', y: 'Y', ex: 'X errors', ey: 'Y errors' };

let datasets = [newDataset('Dataset 1')];
let activeIdx = 0;

function newDataset(name) { return { name, x: '', y: '', ex: '', ey: '' }; }
function datasetColor(i) { return DATASET_COLORS[i % DATASET_COLORS.length]; }

/** Parse one column of text. Returns { values: [numbers], bad: [non-numeric tokens] }. */
function parseColumn(text) {
  const values = [];
  const bad = [];
  for (const t of tokens(text)) {
    const v = Number(t);
    if (Number.isFinite(v)) values.push(v);
    else bad.push(t);
  }
  return { values, bad };
}

/** Split a column of text into its raw tokens (numbers or not). */
function tokens(text) {
  return String(text || '').split(/[\s,;]+/).filter((t) => t !== '');
}

/** The four text boxes -> the active dataset object. */
function syncActiveFromColumns() {
  const d = datasets[activeIdx];
  for (const c of COLUMNS) d[c] = $('col-' + c).value;
}

/** The active dataset object -> the four text boxes. */
function showActiveInColumns() {
  const d = datasets[activeIdx];
  for (const c of COLUMNS) $('col-' + c).value = d[c] || '';
  updateCounts();
}

/** Update the "n=8" badges and flag columns that do not match X. */
function updateCounts() {
  const nx = parseColumn($('col-x').value).values.length;
  for (const c of COLUMNS) {
    const { values, bad } = parseColumn($('col-' + c).value);
    const badge = $('count-' + c);
    badge.textContent = bad.length ? `${values.length} (+${bad.length} bad)` : String(values.length);
    badge.classList.toggle('mismatch', bad.length > 0 || (values.length > 0 && values.length !== nx));
  }
  renderDatasetSelector();
}

function renderDatasetSelector() {
  const sel = $('dataset-select');
  const current = sel.value;
  sel.innerHTML = '';
  datasets.forEach((d, i) => {
    const n = (i === activeIdx) ? parseColumn($('col-x').value).values.length : parseColumn(d.x).values.length;
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${d.name}  (${n} point${n === 1 ? '' : 's'})`;
    sel.appendChild(opt);
  });
  sel.value = String(activeIdx);
  $('dataset-swatch').style.background = datasetColor(activeIdx);
  const removeBtns = document.querySelectorAll('[data-action="dataset-remove"]');
  for (const b of removeBtns) b.disabled = datasets.length <= 1;
  if (current !== sel.value) { /* nothing else to do */ }
}

function setActiveDataset(i) {
  if (i === activeIdx) return;
  syncActiveFromColumns();
  activeIdx = Math.max(0, Math.min(datasets.length - 1, i));
  showActiveInColumns();
  autosave();
}

function addDataset() {
  syncActiveFromColumns();
  datasets.push(newDataset(`Dataset ${datasets.length + 1}`));
  activeIdx = datasets.length - 1;
  showActiveInColumns();
  $('col-x').focus();
  autosave();
}

function renameDataset() {
  const d = datasets[activeIdx];
  const name = prompt('Name for this dataset:', d.name);
  if (name === null) return;
  d.name = name.trim() || d.name;
  renderDatasetSelector();
  autosave();
}

function removeDataset() {
  if (datasets.length <= 1) return;
  syncActiveFromColumns();
  const d = datasets[activeIdx];
  const n = parseColumn(d.x).values.length;
  if (n > 0 && !confirm(`Remove "${d.name}" (${n} points)?`)) return;
  datasets.splice(activeIdx, 1);
  activeIdx = Math.min(activeIdx, datasets.length - 1);
  showActiveInColumns();
  autosave();
}

// ================================================================ 4. data table

// The dialog edits a *copy* of the datasets; "Done" commits, "Cancel" discards.
let tableDatasets = null;
let tableActive = 0;
// Grid column order: Y errors before X errors, so a pasted "x y yerr" block lands right.
const GRID_COLS = ['x', 'y', 'ey', 'ex'];
const MIN_ROWS = 12;

function openTable() {
  syncActiveFromColumns();
  tableDatasets = datasets.map((d) => ({ ...d }));
  tableActive = activeIdx;
  $('import-panel').hidden = true;
  renderTabs();
  renderGrid();
  $('table-dialog').showModal();
  setTimeout(() => { const first = $('grid').querySelector('tbody input'); if (first) first.focus(); }, 50);
}

function renderTabs() {
  const box = $('dataset-tabs');
  box.innerHTML = '';
  tableDatasets.forEach((d, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (i === tableActive ? ' active' : '');
    b.innerHTML = `<span class="swatch" style="background:${datasetColor(i)}"></span><span class="tab-name">${escapeHtml(d.name)}</span>` +
                  (tableDatasets.length > 1 ? `<span class="tab-x" title="Remove this dataset">×</span>` : '');
    b.title = 'Click to edit · double-click to rename';
    b.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('tab-x')) { tableRemoveDataset(i); return; }
      tableSwitch(i);
    });
    b.addEventListener('dblclick', () => {
      const name = prompt('Name for this dataset:', tableDatasets[i].name);
      if (name !== null) { tableDatasets[i].name = name.trim() || tableDatasets[i].name; renderTabs(); }
    });
    box.appendChild(b);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'tab add';
  add.textContent = '+ dataset';
  add.addEventListener('click', () => {
    readGridToDataset();
    tableDatasets.push(newDataset(`Dataset ${tableDatasets.length + 1}`));
    tableActive = tableDatasets.length - 1;
    renderTabs(); renderGrid();
  });
  box.appendChild(add);
}

function tableSwitch(i) {
  if (i === tableActive) return;
  readGridToDataset();
  tableActive = i;
  renderTabs(); renderGrid();
}

function tableRemoveDataset(i) {
  if (tableDatasets.length <= 1) return;
  const n = tokens(tableDatasets[i].x).length;
  if (n > 0 && !confirm(`Remove "${tableDatasets[i].name}" (${n} points)?`)) return;
  if (i !== tableActive) readGridToDataset();
  tableDatasets.splice(i, 1);
  tableActive = Math.min(tableActive > i ? tableActive - 1 : tableActive, tableDatasets.length - 1);
  renderTabs(); renderGrid();
}

/** Build the grid from the active table dataset. */
function renderGrid(extraRows = 3) {
  const d = tableDatasets[tableActive];
  const cols = GRID_COLS.map((c) => tokens(d[c]));
  const n = Math.max(MIN_ROWS, Math.max(...cols.map((c) => c.length)) + extraRows);
  const tbody = $('grid').querySelector('tbody');
  const frag = document.createDocumentFragment();
  for (let r = 0; r < n; r++) frag.appendChild(gridRow(r, cols.map((c) => c[r] ?? '')));
  tbody.innerHTML = '';
  tbody.appendChild(frag);
  updateTableCount();
}

function gridRow(r, values) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="rownum">${r + 1}</td>` +
    values.map((v, c) => `<td><input type="text" inputmode="decimal" spellcheck="false" data-r="${r}" data-c="${c}" value="${escapeHtml(v)}"></td>`).join('') +
    `<td class="rowdel"><button type="button" class="rowdel-btn" tabindex="-1" title="Delete this row">×</button></td>`;
  return tr;
}

function gridInput(r, c) { return $('grid').querySelector(`input[data-r="${r}"][data-c="${c}"]`); }
function gridRowCount() { return $('grid').querySelectorAll('tbody tr').length; }

function appendGridRows(k) {
  const tbody = $('grid').querySelector('tbody');
  let r = gridRowCount();
  for (let i = 0; i < k; i++, r++) tbody.appendChild(gridRow(r, ['', '', '', '']));
}

function renumberGrid() {
  $('grid').querySelectorAll('tbody tr').forEach((tr, r) => {
    tr.querySelector('.rownum').textContent = r + 1;
    tr.querySelectorAll('input').forEach((inp) => { inp.dataset.r = r; });
  });
}

/** The grid -> the active table dataset (as column text). Rows without both
 *  X and Y are skipped; a blank error next to filled ones counts as 0. */
function readGridToDataset() {
  const rows = [...$('grid').querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value.trim()));
  const kept = rows.filter((r) => r[0] !== '' && r[1] !== '');
  const d = tableDatasets[tableActive];
  GRID_COLS.forEach((col, c) => {
    if (c < 2) { d[col] = kept.map((r) => r[c]).join('\n'); return; }
    const any = kept.some((r) => r[c] !== '');
    d[col] = any ? kept.map((r) => r[c] === '' ? '0' : r[c]).join('\n') : '';
  });
  return { total: rows.filter((r) => r.some((v) => v !== '')).length, kept: kept.length };
}

function updateTableCount() {
  const rows = [...$('grid').querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value.trim()));
  const filled = rows.filter((r) => r.some((v) => v !== '')).length;
  const kept = rows.filter((r) => r[0] !== '' && r[1] !== '').length;
  const bad = rows.flat().filter((v) => v !== '' && !Number.isFinite(Number(v))).length;
  let text = `${kept} point${kept === 1 ? '' : 's'}`;
  if (filled > kept) text += ` · ${filled - kept} row${filled - kept === 1 ? '' : 's'} missing X or Y (skipped)`;
  if (bad) text += ` · ${bad} cell${bad === 1 ? '' : 's'} not a number`;
  $('table-count').textContent = text;
}

/** Paste into the grid: a block of rows/columns fills to the right and down
 *  from the focused cell (this is how Excel and Sheets put data on the clipboard). */
function gridPaste(ev) {
  const target = ev.target;
  if (!(target instanceof HTMLInputElement) || target.dataset.r === undefined) return;
  const text = (ev.clipboardData || window.clipboardData).getData('text');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return;
  const rows = lines.map((l) => l.trim().split(/\t|;|,\s*|\s+/).filter((c) => c !== ''));
  if (rows.length === 1 && rows[0].length === 1) return;          // a single value: normal paste
  ev.preventDefault();
  const r0 = parseInt(target.dataset.r, 10);
  const c0 = parseInt(target.dataset.c, 10);
  const need = r0 + rows.length + 2 - gridRowCount();
  if (need > 0) appendGridRows(need);
  rows.forEach((cells, i) => {
    cells.forEach((v, j) => {
      const c = c0 + j;
      if (c > 3) return;
      const inp = gridInput(r0 + i, c);
      if (inp) inp.value = v;
    });
  });
  updateTableCount();
}

function gridKeydown(ev) {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement) || t.dataset.r === undefined) return;
  const r = parseInt(t.dataset.r, 10);
  const c = parseInt(t.dataset.c, 10);
  let next = null;
  if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
    if (r + 1 >= gridRowCount()) appendGridRows(1);
    next = gridInput(r + 1, c);
  } else if (ev.key === 'ArrowUp') {
    next = gridInput(r - 1, c);
  }
  if (next) { ev.preventDefault(); next.focus(); next.select(); }
}

function gridDeleteRow(btn) {
  const tr = btn.closest('tr');
  tr.remove();
  renumberGrid();
  if (gridRowCount() < MIN_ROWS) appendGridRows(MIN_ROWS - gridRowCount());
  updateTableCount();
}

function tableDeleteEmpty() {
  for (const tr of [...$('grid').querySelectorAll('tbody tr')]) {
    if ([...tr.querySelectorAll('input')].every((i) => i.value.trim() === '')) tr.remove();
  }
  renumberGrid();
  appendGridRows(Math.max(3, MIN_ROWS - gridRowCount()));
  updateTableCount();
}

// --- import from text with a column mapping ---
const IMPORT_TARGETS = [['x', 'X'], ['y', 'Y'], ['ey', 'Y err'], ['ex', 'X err'], ['', 'ignore']];

function importRows() {
  return $('import-text').value.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
    .map((l) => l.split(/\t|;|,\s*|\s+/).filter((c) => c !== ''));
}

function renderImportMapping() {
  const rows = importRows();
  const ncol = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
  const box = $('import-mapping');
  box.innerHTML = '';
  if (!ncol) { box.innerHTML = '<span class="hint">Paste some text above to see its columns.</span>'; return; }
  const defaults = { 1: ['y'], 2: ['x', 'y'], 3: ['x', 'y', 'ey'], 4: ['x', 'y', 'ey', 'ex'] }[Math.min(ncol, 4)] || [];
  for (let c = 0; c < ncol; c++) {
    const sample = rows.slice(0, 3).map((r) => r[c] ?? '').join(', ');
    const sel = document.createElement('select');
    sel.dataset.col = c;
    for (const [v, label] of IMPORT_TARGETS) {
      const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o);
    }
    sel.value = (c < 4 ? defaults[c] : '') ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.innerHTML = `<label>Column ${c + 1} <span class="hint-inline">(${escapeHtml(sample)}…)</span></label>`;
    wrap.appendChild(sel);
    box.appendChild(wrap);
  }
  const note = document.createElement('span');
  note.className = 'hint';
  note.textContent = `${rows.length} rows, ${ncol} columns detected.` + (ncol === 1 ? ' With one column, X becomes 1, 2, 3, …' : '');
  box.appendChild(note);
}

function importApply() {
  const rows = importRows();
  if (!rows.length) return;
  const mapping = [...$('import-mapping').querySelectorAll('select')].map((s) => s.value);
  const d = tableDatasets[tableActive];
  const out = { x: [], y: [], ex: [], ey: [] };
  rows.forEach((r, i) => {
    mapping.forEach((target, c) => { if (target && r[c] !== undefined) out[target].push(r[c]); });
    if (!mapping.includes('x')) out.x.push(String(i + 1));
  });
  for (const c of GRID_COLS) d[c] = out[c].join('\n');
  $('import-panel').hidden = true;
  renderGrid();
}

function tableDone() {
  readGridToDataset();
  datasets = tableDatasets;
  activeIdx = Math.min(tableActive, datasets.length - 1);
  tableDatasets = null;
  showActiveInColumns();
  $('table-dialog').close();
  autosave();
}

function tableCancel() {
  tableDatasets = null;
  $('table-dialog').close();
}

const TABLE_ACTIONS = {
  'add-rows': () => { appendGridRows(10); updateTableCount(); },
  'delete-empty': tableDeleteEmpty,
  'clear': () => { if (confirm('Clear every cell of this dataset?')) { const d = tableDatasets[tableActive]; for (const c of GRID_COLS) d[c] = ''; renderGrid(); } },
  'import': () => { $('import-panel').hidden = false; renderImportMapping(); $('import-text').focus(); },
  'import-apply': importApply,
  'import-cancel': () => { $('import-panel').hidden = true; },
  'done': tableDone,
  'cancel': tableCancel,
};

// ================================================================ 5. form <-> object

/** Split "a, b, c" into ["a","b","c"], keeping empty slots ("1,,3"). */
function splitList(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  return s.split(',').map((t) => t.trim());
}

function numberOrNull(text) {
  const s = String(text || '').trim();
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

/** Everything the user typed, as one plain object (what gets saved). */
function readForm() {
  syncActiveFromColumns();
  const active = datasets[activeIdx];
  return {
    datasets: datasets.map((d) => ({ ...d })),
    active: activeIdx,
    data: { x: active.x, y: active.y, ex: active.ex, ey: active.ey },   // the active dataset, for older readers
    formula: $('formula').value,
    param_names: $('param-names').value,
    initial_guesses: $('initial-guesses').value,
    graph_title: $('graph-title').value,
    x_title: $('x-title').value,
    y_title: $('y-title').value,
    options: {
      x_min: $('fit-xmin').value.trim(),
      x_max: $('fit-xmax').value.trim(),
      logx: $('opt-logx').checked,
      logy: $('opt-logy').checked,
      grid: $('opt-grid').checked,
      residuals: $('opt-resid').value,
    },
  };
}

function writeForm(inputs) {
  inputs = inputs || {};
  if (Array.isArray(inputs.datasets) && inputs.datasets.length) {
    datasets = inputs.datasets.map((d, i) => ({
      name: String((d && d.name) || `Dataset ${i + 1}`),
      x: String((d && d.x) || ''), y: String((d && d.y) || ''), ex: String((d && d.ex) || ''), ey: String((d && d.ey) || ''),
    }));
    activeIdx = Math.max(0, Math.min(datasets.length - 1, parseInt(inputs.active, 10) || 0));
  } else {
    const d = inputs.data || {};
    datasets = [{ name: 'Dataset 1', x: String(d.x || ''), y: String(d.y || ''), ex: String(d.ex || ''), ey: String(d.ey || '') }];
    activeIdx = 0;
  }
  showActiveInColumns();
  $('formula').value = inputs.formula || '';
  $('param-names').value = inputs.param_names || '';
  $('initial-guesses').value = inputs.initial_guesses || '';
  $('graph-title').value = inputs.graph_title || '';
  $('x-title').value = inputs.x_title || '';
  $('y-title').value = inputs.y_title || '';
  const o = inputs.options || {};
  $('fit-xmin').value = o.x_min ?? '';
  $('fit-xmax').value = o.x_max ?? '';
  $('opt-logx').checked = !!o.logx;
  $('opt-logy').checked = !!o.logy;
  $('opt-grid').checked = o.grid === undefined ? true : !!o.grid;
  $('opt-resid').value = ['residual', 'pull', 'none'].includes(o.residuals) ? o.residuals : 'residual';
  renderParamTable();
}

function clearForm() {
  writeForm({ formula: '[0]*x+[1]' });
  $('doc-title').value = '';
  $('doc-notes').value = '';
  clearReport();
  $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
  setPngEnabled(false);
  lastResult = null;
  lastPayload = null;
  lastDrawn = null;
  showMessage('');
  setStatus($('fit-status'), 'Ready');
}

/** Buttons that only make sense once there is a plot / a result. */
function setPngEnabled(on) {
  $('btn-png').disabled = !on;
  for (const el of document.querySelectorAll('[data-needs-plot]')) el.disabled = !on;
}
function setResultEnabled(on) {
  for (const el of document.querySelectorAll('[data-needs-result]')) el.disabled = !on;
  $('report-tools').hidden = !on;
}

/** Turn the form into the JSON body the backend expects. Throws an Error with
 *  a human-readable message if the data cannot be used. */
function buildPayload(inputs) {
  const cols = {};
  for (const c of COLUMNS) {
    const { values, bad } = parseColumn(inputs.data[c]);
    if (bad.length) {
      throw new Error(`${COLUMN_LABEL[c]}: "${bad[0]}" is not a number${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}.`);
    }
    cols[c] = values;
  }
  const name = datasets[activeIdx].name;
  if (cols.x.length === 0) throw new Error(`Paste some X values first (${name} is empty).`);
  if (cols.y.length === 0) throw new Error('Paste some Y values first.');
  if (cols.x.length !== cols.y.length) throw new Error(`X has ${cols.x.length} points but Y has ${cols.y.length}. They must match.`);
  if (cols.ex.length && cols.ex.length !== cols.x.length) throw new Error(`X errors: ${cols.ex.length} values for ${cols.x.length} points. Give one per point or leave the column empty.`);
  if (cols.ey.length && cols.ey.length !== cols.x.length) throw new Error(`Y errors: ${cols.ey.length} values for ${cols.x.length} points. Give one per point or leave the column empty.`);
  if (!inputs.formula.trim()) throw new Error('Type a fit function, e.g. [0]*x+[1].');

  const o = inputs.options || {};
  const xmin = numberOrNull(o.x_min);
  const xmax = numberOrNull(o.x_max);
  if (Number.isNaN(xmin) || Number.isNaN(xmax)) throw new Error('The fit range must be two numbers (or both blank).');
  let x_range = null;
  if (xmin !== null || xmax !== null) {
    const lo = xmin === null ? Math.min(...cols.x) : xmin;
    const hi = xmax === null ? Math.max(...cols.x) : xmax;
    if (!(lo < hi)) throw new Error(`Fit range: "from" (${lo}) must be smaller than "to" (${hi}).`);
    const inside = cols.x.filter((v) => v >= lo && v <= hi).length;
    if (inside < 2) throw new Error(`Only ${inside} point(s) fall inside the fit range [${lo}, ${hi}].`);
    x_range = [lo, hi];
  }

  return {
    x: cols.x, y: cols.y, ex: cols.ex, ey: cols.ey,
    formula: inputs.formula.trim(),
    param_names: splitList(inputs.param_names),
    initial_guesses: splitList(inputs.initial_guesses).map((g) => (g === '' ? null : g)),
    title: inputs.graph_title,
    x_title: inputs.x_title,
    y_title: inputs.y_title,
    x_range,
    plot: { logx: !!o.logx, logy: !!o.logy, grid: o.grid !== false, residuals: o.residuals || 'residual' },
    dataset_name: name,
  };
}

// ================================================================ 6. parameters

const NAMED_NPAR = { gaus: 3, gausn: 3, expo: 2, landau: 3, landaun: 3, crystalball: 5, crystalballn: 5, breitwigner: 3 };

/** How many parameters a formula has: the highest [n] + 1, named parameters
 *  [a], [b], and ROOT's named functions with their optional offset, gaus(3). */
function countParams(formula) {
  let n = 0;
  const named = new Set();
  for (const m of formula.matchAll(/\[([A-Za-z_]\w*|\d+)\]/g)) {
    if (/^\d+$/.test(m[1])) n = Math.max(n, parseInt(m[1], 10) + 1);
    else named.add(m[1]);
  }
  n = Math.max(n, named.size);
  const re = /\b(gaus|gausn|expo|landau|landaun|crystalball|crystalballn|breitwigner|pol(\d+)|chebyshev(\d+))\b(?:\s*\(\s*(\d+)\s*\))?/g;
  for (const m of formula.matchAll(re)) {
    let np = 0;
    if (m[2] !== undefined) np = parseInt(m[2], 10) + 1;
    else if (m[3] !== undefined) np = parseInt(m[3], 10) + 1;
    else np = NAMED_NPAR[m[1]] || 0;
    const off = m[4] !== undefined ? parseInt(m[4], 10) : 0;
    n = Math.max(n, off + np);
  }
  return n;
}

let paramTableBusy = false;

/** Rebuild the parameter table from the formula + the two comma lists. */
function renderParamTable() {
  if (paramTableBusy) return;
  const n = countParams($('formula').value);
  const names = splitList($('param-names').value);
  const guesses = splitList($('initial-guesses').value);
  const tbody = $('param-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="idx">[${i}]</td>` +
      `<td><input type="text" data-pname="${i}" value="${escapeHtml(names[i] || '')}" placeholder="p${i}" spellcheck="false"></td>` +
      `<td><input type="text" class="mono" inputmode="decimal" data-pguess="${i}" value="${escapeHtml(guesses[i] || '')}" placeholder="0"></td>`;
    tbody.appendChild(tr);
  }
  const note = $('param-table-note');
  if (n === 0) note.textContent = 'No parameters found in the formula.';
  else {
    const extra = Math.max(names.length, guesses.length) - n;
    note.textContent = `${n} parameter${n === 1 ? '' : 's'} in the formula.` + (extra > 0 ? ` (${extra} extra value${extra === 1 ? '' : 's'} in the lists are ignored.)` : '');
  }
}

/** The table -> the comma lists (the lists remain the source of truth). */
function paramTableToLists() {
  paramTableBusy = true;
  const names = [...$('param-table').querySelectorAll('input[data-pname]')].map((i) => i.value.trim());
  const guesses = [...$('param-table').querySelectorAll('input[data-pguess]')].map((i) => i.value.trim());
  const trimEnd = (arr) => { let k = arr.length; while (k > 0 && arr[k - 1] === '') k--; return arr.slice(0, k); };
  $('param-names').value = trimEnd(names).join(', ');
  $('initial-guesses').value = trimEnd(guesses).join(', ');
  paramTableBusy = false;
  autosave();
}

// ================================================================ 7. backend

function backendUrl() {
  return ($('backend-url').value || DEFAULT_BACKEND).trim().replace(/\/+$/, '');
}

/** fetch() with a timeout and errors translated into plain-language messages. */
async function callBackend(path, options = {}, timeoutMs = 60000) {
  const url = backendUrl() + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`The backend at ${url} did not answer within ${timeoutMs / 1000} s.`);
    throw new Error(
      `Could not reach the backend at ${backendUrl()}.\n` +
      'Is the Docker container running?  (docker run --rm -p 8000:8000 rootfit-backend)\n' +
      'If it runs on another machine, change the Backend URL under Options.');
  }
  clearTimeout(timer);

  let body = null;
  const text = await response.text();
  try { body = JSON.parse(text); } catch (_) { /* not JSON */ }

  if (!response.ok) {
    const msg = body && body.error ? body.error : `HTTP ${response.status} ${response.statusText}`;
    throw new Error(msg);
  }
  if (body === null) throw new Error(`The backend replied with something that is not JSON:\n${text.slice(0, 200)}`);
  return body;
}

async function checkHealth() {
  const el = $('health-status');
  setStatus(el, 'Backend: checking', 'busy');
  try {
    const h = await callBackend('/health', {}, 8000);
    setStatus(el, `Backend: connected, ROOT ${h.root_version}`, 'ok');
  } catch (e) {
    setStatus(el, 'Backend: ' + e.message.split('\n')[0], 'err');
  }
}

let lastResult = null;    // the last successful /fit response (used by save & export)
let lastPayload = null;   // what was sent for it

async function runFit() {
  showMessage('');
  hideHelp();
  let payload;
  try {
    payload = buildPayload(readForm());
  } catch (e) {
    showMessage('error', e.message);
    return;
  }

  const btn = $('btn-fit');
  btn.disabled = true;
  setStatus($('fit-status'), 'Fitting', 'busy');
  try {
    const result = await callBackend('/fit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    lastResult = result;
    lastPayload = payload;
    renderReport(result);
    await drawPlot(result);
    autosave();
    if (!result.converged) {
      let advice = 'Try better initial guesses.';
      const stuckAtZero = result.params.filter((p) => p.value === 0 && p.error === 0).length;
      if (payload.initial_guesses.length === 0) {
        advice = 'You gave no initial guesses, so every parameter started at 0 — for a non-linear function that is ' +
                 'often a dead end. Read rough values off the plot (peak height, position, width, decay constant…) ' +
                 'and enter them under "Initial guesses".';
      } else if (stuckAtZero > 0) {
        advice = `${stuckAtZero} parameter(s) never moved away from 0. Give them a non-zero starting value.`;
      }
      showMessage('warn', `The fit did not converge cleanly: ${result.status_message} ${advice}`);
    }
    setStatus($('fit-status'), `Fit done — ${payload.dataset_name}`, 'ok');
  } catch (e) {
    showMessage('error', e.message);
    setStatus($('fit-status'), 'Fit failed', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ================================================================ 8. fit report

function chi2Class(r) {
  if (r.chi2_ndf === null || !lastPayload || !lastPayload.ey || lastPayload.ey.length === 0) return '';
  const v = r.chi2_ndf;
  if (v >= 0.5 && v <= 2) return 'good';
  if (v >= 0.2 && v <= 5) return 'meh';
  return 'bad';
}

function renderReport(r) {
  const rows = r.params.map((p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td class="num" title="${p.value} ± ${p.error}">${fmtPair(p.value, p.error)}</td>
      <td class="num">${fmtNum(p.value, 8)}</td>
      <td class="num">${fmtNum(p.error, 4)}</td>
    </tr>`).join('');

  const conv = r.converged
    ? `<span class="converged">${escapeHtml(r.status_message)}</span>`
    : `<span class="not-converged">${escapeHtml(r.status_message)}</span>`;
  const ds = lastPayload && lastPayload.dataset_name ? ` <span class="ds-name">${escapeHtml(lastPayload.dataset_name)}</span>,` : '';
  const weighted = lastPayload && lastPayload.ey && lastPayload.ey.length ? '' : ' <span class="fine">(no Y errors: χ² in arbitrary units)</span>';

  $('report').innerHTML = `
    <p>Function <code>${escapeHtml(r.formula)}</code> on${ds} x ∈ [${fmtNum(r.range[0])}, ${fmtNum(r.range[1])}], ${r.n_points} points. ${conv}${weighted}</p>
    ${residualSummary(r)}
    <table class="report-table">
      <thead><tr><th>Parameter</th><th>Value ± uncertainty</th><th>Full value</th><th>Full error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="summary">
      <div class="stat"><span class="k">χ²</span><span class="v">${fmtNum(r.chi2)}</span></div>
      <div class="stat"><span class="k">NDF</span><span class="v">${r.ndf}</span></div>
      <div class="stat ${chi2Class(r)}"><span class="k">χ² / NDF</span><span class="v">${r.chi2_ndf === null ? '—' : fmtNum(r.chi2_ndf, 4)}</span></div>
      <div class="stat"><span class="k">p-value</span><span class="v">${fmtNum(r.prob, 4)}</span></div>
    </div>`;
  setResultEnabled(true);
}

/** One line about the residuals: RMS, and the worst pull if errors exist. */
function residualSummary(r) {
  const R = r.residuals;
  if (!R || !Array.isArray(R.values) || !R.values.length) return '';
  const n = R.values.length;
  const rms = Math.sqrt(R.values.reduce((a, v) => a + v * v, 0) / n);
  let text = `Residuals (data − fit): RMS ${fmtNum(rms, 3)}`;
  if (R.pull_available && lastPayload && Array.isArray(lastPayload.x)) {
    let worst = 0, at = 0, outside = 0;
    R.values.forEach((v, i) => {
      const pull = Math.abs(v / R.sigma[i]);
      if (pull > worst) { worst = pull; at = i; }
      if (pull > 2) outside += 1;
    });
    text += `; largest pull ${fmtNum(worst, 3)}σ at x = ${fmtNum(lastPayload.x[at], 4)}; ${outside} of ${n} points beyond 2σ` +
            ` (expect about ${Math.max(1, Math.round(0.046 * n))} for a good fit).`;
  } else {
    text += '.';
  }
  return `<p class="fine">${text}</p>`;
}

function clearReport() {
  $('report').innerHTML = '<p class="placeholder-text">No fit yet.</p>';
  setResultEnabled(false);
}

/** The report as plain text (for the clipboard and .txt export). */
function reportText(r) {
  const L = [];
  L.push(`ROOT Fit report — ${$('doc-title').value || 'untitled'}`);
  L.push(`Date:      ${new Date().toISOString()}`);
  if (lastPayload) L.push(`Dataset:   ${lastPayload.dataset_name} (${r.n_points} points)`);
  L.push(`Function:  ${r.formula}`);
  L.push(`Fit range: [${r.range[0]}, ${r.range[1]}]`);
  L.push(`Status:    ${r.status_message} (Minuit status ${r.status})`);
  L.push('');
  const w = Math.max(9, ...r.params.map((p) => p.name.length));
  L.push(`${'Parameter'.padEnd(w)}  ${'Value'.padStart(16)}  ${'Uncertainty'.padStart(16)}`);
  for (const p of r.params) L.push(`${p.name.padEnd(w)}  ${String(p.value).padStart(16)}  ${String(p.error).padStart(16)}`);
  L.push('');
  L.push(`chi2     = ${r.chi2}`);
  L.push(`NDF      = ${r.ndf}`);
  L.push(`chi2/NDF = ${r.chi2_ndf}`);
  L.push(`p-value  = ${r.prob}`);
  if (r.covariance && r.covariance.length) {
    L.push('');
    L.push('Covariance matrix:');
    for (const row of r.covariance) L.push('  ' + row.map((v) => String(v).padStart(16)).join(' '));
  }
  return L.join('\n') + '\n';
}

function reportCsv(r) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const L = ['parameter,value,error'];
  for (const p of r.params) L.push(`${q(p.name)},${p.value},${p.error}`);
  L.push('');
  L.push('quantity,value');
  L.push(`chi2,${r.chi2}`);
  L.push(`ndf,${r.ndf}`);
  L.push(`chi2_ndf,${r.chi2_ndf}`);
  L.push(`prob,${r.prob}`);
  L.push(`status,${q(r.status_message)}`);
  L.push(`formula,${q(r.formula)}`);
  L.push(`x_min,${r.range[0]}`);
  L.push(`x_max,${r.range[1]}`);
  return L.join('\n') + '\n';
}

async function copyReport() {
  if (!lastResult) return;
  const text = reportText(lastResult);
  try {
    await navigator.clipboard.writeText(text);
    showMessage('info', 'Fit report copied to the clipboard.');
  } catch (_) {
    downloadText(text, fileBaseName() + '-report.txt');
  }
}

// ================================================================ 9. plot (JSROOT)

// JSROOT is CERN's JavaScript library that understands ROOT objects. The
// backend sends the finished TCanvas as ROOT-JSON; JSROOT draws it exactly
// as ROOT would. It is loaded on demand with a classic <script> tag (module
// imports are blocked on file:// pages). Two URLs in case the CDN layout changes.
const JSROOT_URLS = [
  'https://root.cern/js/latest/build/jsroot.min.js',
  'https://root.cern/js/latest/build/jsroot.js',
];
let jsrootPromise = null;
let lastDrawn = null;   // { json, option } of the object on screen
let lastPainter = null; // the JSROOT painter of what is on screen (used for export)

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(url);
    s.onerror = () => { s.remove(); reject(new Error(`could not load ${url}`)); };
    document.head.appendChild(s);
  });
}

function loadJSROOT() {
  if (!jsrootPromise) {
    jsrootPromise = (async () => {
      if (!window.JSROOT) {
        let lastError = null;
        for (const url of JSROOT_URLS) {
          try { await loadScript(url); break; } catch (e) { lastError = e; }
        }
        if (!window.JSROOT) throw lastError || new Error('JSROOT did not define window.JSROOT');
      }
      const m = window.JSROOT;
      m.settings.PreferSavedPoints = true;   // draw the TF1 from ROOT's own sampled points
      m.gStyle.fOptFit = 1111;               // fit box when a bare graph is drawn
      m.gStyle.fOptStat = 0;
      return m;
    })().catch((e) => {
      jsrootPromise = null;
      throw new Error(`Could not load JSROOT from root.cern — are you online? (${e.message})`);
    });
  }
  return jsrootPromise;
}

function drawableFrom(result) {
  if (result && result.canvas_json) return { json: result.canvas_json, option: '' };
  if (result && result.graph_json) return { json: result.graph_json, option: 'AP' };
  return null;
}

async function drawPlot(result) {
  const plot = $('plot');
  const src = drawableFrom(result);
  setPngEnabled(false);
  lastDrawn = null;
  lastPainter = null;
  if (!src) {
    plot.innerHTML = '<p class="placeholder">The backend returned no plot.</p>';
    return;
  }
  let jsroot;
  try {
    jsroot = await loadJSROOT();
  } catch (e) {
    plot.innerHTML = `<p class="placeholder">${escapeHtml(e.message)}<br>The fit report below is still valid.</p>`;
    return;
  }
  try {
    jsroot.cleanup(plot);
    plot.innerHTML = '';
    const obj = jsroot.parse(JSON.stringify(src.json));      // parse() edits its input: give it a copy
    const painter = await jsroot.draw(plot, obj, src.option);
    jsroot.registerForResize(painter);
    lastDrawn = src;
    lastPainter = painter;
    setPngEnabled(true);
    setStatus($('jsroot-status'), `JSROOT ${jsroot.version}`);
  } catch (e) {
    plot.innerHTML = `<p class="placeholder">JSROOT could not draw the result: ${escapeHtml(e.message)}</p>`;
  }
}

/** Tell JSROOT the plot box changed size (after dragging the handle). */
function replotToSize() {
  if (window.JSROOT && lastDrawn) {
    try { window.JSROOT.resize($('plot'), true); } catch (_) { /* ignore */ }
  }
}

/** The plot exactly as it is on screen, as SVG text. JSROOT's produceImage
 *  takes the live drawing (same size, same fonts, same layout) rather than
 *  re-rendering at another size, which would change the proportions. */
async function currentPlotSvg() {
  if (!lastPainter) throw new Error('There is no plot to export yet.');
  const canv = (typeof lastPainter.getCanvPainter === 'function' && lastPainter.getCanvPainter()) || lastPainter;
  if (typeof canv.produceImage !== 'function') throw new Error('JSROOT did not give a canvas painter.');
  const svg = await canv.produceImage(true, 'svg');
  if (!svg) throw new Error('JSROOT returned an empty picture.');
  return svg;
}

/** Draw an SVG string onto a bitmap `scale` times larger than its own size
 *  (2x = the same picture, just crisper), white background, as a PNG data URL. */
function rasterizeSvg(svgText, scale) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      try { resolve(c.toDataURL('image/png')); } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('the browser could not render the SVG')); };
    img.src = url;
  });
}

async function exportPng() {
  if (!lastDrawn) return;
  const btn = $('btn-png');
  btn.disabled = true;
  try {
    const svg = await currentPlotSvg();
    const dataUrl = await rasterizeSvg(svg, 2);
    downloadDataUrl(dataUrl, fileBaseName() + '.png');
  } catch (e) {
    showMessage('error', 'PNG export failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function exportSvg() {
  if (!lastDrawn) return;
  try {
    const svg = await currentPlotSvg();
    downloadText(svg, fileBaseName() + '.svg', 'image/svg+xml');
  } catch (e) {
    showMessage('error', 'SVG export failed: ' + e.message);
  }
}

// --- resizable panels: a splitter between the columns and a handle under the plot ---
function loadLayout() {
  try { return JSON.parse(storageGet(LAYOUT_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function saveLayout(patch) { storageSet(LAYOUT_KEY, JSON.stringify({ ...loadLayout(), ...patch })); }

function applyLayout() {
  const l = loadLayout();
  if (l.left) $('main').style.setProperty('--left-w', l.left + 'px');
  if (l.plotH) $('plot').style.height = l.plotH + 'px';
}

function resetLayout() {
  storageRemove(LAYOUT_KEY);
  $('main').style.removeProperty('--left-w');
  $('plot').style.height = '';
  replotToSize();
}

function initResizers() {
  applyLayout();
  const main = $('main');
  const splitter = $('splitter');
  splitter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    splitter.setPointerCapture(ev.pointerId);
    document.body.classList.add('resizing-x');
    const rect = main.getBoundingClientRect();
    const move = (e) => {
      const w = Math.max(300, Math.min(rect.width - 380, e.clientX - rect.left - 16));
      main.style.setProperty('--left-w', w + 'px');
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-x');
      const w = parseFloat(getComputedStyle(main).getPropertyValue('--left-w'));
      if (w) saveLayout({ left: Math.round(w) });
      replotToSize();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
  splitter.addEventListener('dblclick', resetLayout);

  const handle = $('plot-resizer');
  const plot = $('plot');
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    document.body.classList.add('resizing-y');
    const startY = ev.clientY;
    const startH = plot.clientHeight;
    const move = (e) => { plot.style.height = Math.max(240, Math.min(1400, startH + e.clientY - startY)) + 'px'; };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-y');
      saveLayout({ plotH: plot.clientHeight });
      replotToSize();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => { plot.style.height = ''; saveLayout({ plotH: null }); replotToSize(); });
}

// ================================================================ 10. documents

const DOC_VERSION = 1;
const APP_VERSION = '0.2.0';
const AUTOSAVE_KEY = 'rootfit.autosave';
let documentCreated = null;

function buildDocument() {
  const now = new Date().toISOString();
  if (!documentCreated) documentCreated = now;
  return {
    version: DOC_VERSION,
    app: 'rootfit',
    app_version: APP_VERSION,
    created: documentCreated,
    modified: now,
    title: $('doc-title').value,
    notes: $('doc-notes').value,
    inputs: readForm(),
    results: lastResult,
    results_payload: lastPayload,      // which dataset / options produced the results
    backend_url: backendUrl(),
  };
}

function saveDocument() {
  const text = JSON.stringify(buildDocument(), null, 1);
  downloadText(text, fileBaseName() + '.json', 'application/json');
  showMessage('info', 'Document saved to your downloads folder.');
}

function applyDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('This is not a ROOT Fit document (expected a JSON object with "version" and "inputs").');
  }
  if (doc.version !== DOC_VERSION) {
    throw new Error(`Unsupported document version "${doc.version}" — this page understands version ${DOC_VERSION}.`);
  }
  if (!doc.inputs || typeof doc.inputs !== 'object') {
    throw new Error('The document has no "inputs" section.');
  }
  writeForm(doc.inputs);
  $('doc-title').value = doc.title || '';
  $('doc-notes').value = doc.notes || '';
  documentCreated = doc.created || null;

  lastResult = (doc.results && Array.isArray(doc.results.params)) ? doc.results : null;
  lastPayload = lastResult ? (doc.results_payload || null) : null;
  showMessage('');
  if (lastResult) {
    renderReport(lastResult);
    drawPlot(lastResult);
  } else {
    clearReport();
    $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
    setPngEnabled(false);
    lastDrawn = null;
  }
}

function loadDocumentText(text, sourceName) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    showMessage('error', `${sourceName} is not valid JSON: ${e.message}`);
    return false;
  }
  try {
    applyDocument(doc);
  } catch (e) {
    showMessage('error', e.message);
    return false;
  }
  showMessage('info', `Loaded ${sourceName}${doc.title ? ` — "${doc.title}"` : ''}.`);
  autosave();
  return true;
}

function loadDocumentFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadDocumentText(reader.result, file.name);
  reader.onerror = () => showMessage('error', `Could not read ${file.name}.`);
  reader.readAsText(file);
}

let autosaveTimer = null;
function autosaveNow() {
  autosaveTimer = null;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildDocument()));
  } catch (_) {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...buildDocument(), results: null })); } catch (__) { /* give up */ }
  }
}
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, 400);
}
window.addEventListener('pagehide', () => { if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveNow(); } });

function restoreAutosave() {
  const text = storageGet(AUTOSAVE_KEY);
  if (!text) return false;
  try {
    applyDocument(JSON.parse(text));
    showMessage('info', 'Restored your previous session from this browser (autosave). Use "Save document" to keep a file.');
    return true;
  } catch (_) {
    return false;
  }
}

function clearAutosave() { storageRemove(AUTOSAVE_KEY); }

// ================================================================ 11. menus & actions

// The three example documents from examples/, embedded so the Fit menu can load
// them even when the page is opened from disk (a file:// page cannot fetch files).
const EXAMPLES = {
  linear: {
    title: 'Straight line (reference dataset)',
    notes: 'Same data as tests/linear_reference.json. Expected: slope 1.975 ± 0.046, intercept 0.23 ± 0.18, chi2/NDF = 2.10/6.',
    inputs: { datasets: [{ name: 'Reference line', x: '1\n2\n3\n4\n5\n6\n7\n8', y: '2.3\n4.1\n6.2\n7.9\n10.3\n11.8\n14.1\n16.2', ex: '', ey: '0.2\n0.2\n0.3\n0.3\n0.3\n0.4\n0.4\n0.4' }], active: 0,
      formula: '[0]*x+[1]', param_names: 'slope, intercept', initial_guesses: '1, 0', graph_title: 'Straight line', x_title: 'x', y_title: 'y', options: {} },
  },
  exp: {
    title: 'Exponential decay with background',
    notes: 'Counts vs time. Poisson errors on y (sqrt N), 0.05 s timing error on x. Try the same fit without the [2] background term and compare chi2/NDF.',
    inputs: { datasets: [{ name: 'Decay run 1', x: '0\n0.5\n1\n1.5\n2\n2.5\n3\n3.5\n4\n4.5\n5\n5.5\n6\n6.5\n7\n7.5\n8\n8.5\n9\n9.5\n10',
      y: '990\n838\n688.7\n563.5\n482.8\n396.1\n353.9\n323.1\n248.1\n210.2\n195.9\n148.9\n141.5\n112.3\n103.9\n99.15\n83.15\n67.29\n52.82\n74.8\n57.75',
      ex: '0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05',
      ey: '31.5\n28.8\n26.4\n24.2\n22.2\n20.4\n18.8\n17.3\n16\n14.8\n13.7\n12.8\n11.9\n11.2\n10.6\n10\n9.53\n9.11\n8.75\n8.44\n8.17' }], active: 0,
      formula: '[0]*exp(-x/[1])+[2]', param_names: 'N0, tau, background', initial_guesses: '1000, 2, 10', graph_title: 'Decay curve', x_title: 't (s)', y_title: 'counts', options: {} },
  },
  gaus: {
    title: 'Gaussian peak on flat background',
    notes: "Uses ROOT's named functions: gaus(0) takes parameters 0-2, pol0(3) takes parameter 3. Because this is a SUM of named functions, ROOT does not compute starting values for it, so the guesses matter: read the peak height (~120), position (~10) and width (~1.5) off the plot and the background (~15) from the flat part. Try clearing the guesses to see how the fit collapses to a flat line.",
    inputs: { datasets: [{ name: 'Spectrum', x: '0\n0.5\n1\n1.5\n2\n2.5\n3\n3.5\n4\n4.5\n5\n5.5\n6\n6.5\n7\n7.5\n8\n8.5\n9\n9.5\n10\n10.5\n11\n11.5\n12\n12.5\n13\n13.5\n14\n14.5\n15\n15.5\n16\n16.5\n17\n17.5\n18\n18.5\n19\n19.5\n20',
      y: '14.5\n10.13\n16.11\n15.68\n14.24\n4.921\n13.16\n15.09\n15.26\n9.354\n13.85\n12.09\n15.19\n26.86\n24.5\n40.71\n64.69\n73.53\n100\n122.4\n133.5\n120.2\n124.9\n119.7\n69.08\n68.36\n44.43\n27.13\n32.58\n21.56\n12.13\n16.24\n17.62\n14.31\n17.68\n15.19\n17.55\n20.44\n12.14\n15.8\n12.86',
      ex: '', ey: '3.87\n3.87\n3.88\n3.88\n3.89\n3.9\n3.92\n3.96\n4.03\n4.16\n4.42\n4.88\n5.62\n6.58\n7.68\n8.79\n9.79\n10.6\n11.2\n11.5\n11.6\n11.5\n11.1\n10.4\n9.51\n8.5\n7.46\n6.44\n5.55\n4.85\n4.4\n4.15\n4.03\n3.95\n3.91\n3.9\n3.88\n3.88\n3.87\n3.87\n3.87' }], active: 0,
      formula: 'gaus(0)+pol0(3)', param_names: 'amplitude, mean, sigma, background', initial_guesses: '120, 10, 1.5, 15', graph_title: 'Spectrum', x_title: 'channel', y_title: 'counts', options: {} },
  },
};

function loadExample(key) {
  const ex = EXAMPLES[key];
  if (!ex) return;
  applyDocument({ version: DOC_VERSION, title: ex.title, notes: ex.notes, inputs: ex.inputs, results: null });
  documentCreated = null;
  showMessage('info', `Loaded the example "${ex.title}". Press Fit.`);
  autosave();
}

function clearEverything() {
  if (!confirm('Clear the whole form? (Save the document first if you want to keep it.)')) return;
  clearForm();
  documentCreated = null;
  clearAutosave();
}

function openLoadDialog() { $('paste-area').value = ''; $('paste-dialog').showModal(); }
function openSettings() { $('settings-dialog').showModal(); $('backend-url').focus(); }
function openAbout() {
  const v = [`Document format version ${DOC_VERSION}`, `page ${APP_VERSION}`];
  if (window.JSROOT) v.push(`JSROOT ${window.JSROOT.version}`);
  $('about-versions').textContent = v.join(' · ');
  $('about-dialog').showModal();
}

/** Every menu item and toolbar button names what it does in data-action. */
const ACTIONS = {
  load: openLoadDialog,
  save: saveDocument,
  png: exportPng,
  svg: exportSvg,
  clear: clearEverything,
  fit: runFit,
  example: (el) => loadExample(el.dataset.example),
  settings: openSettings,
  health: checkHealth,
  about: openAbout,
  table: openTable,
  'dataset-add': addDataset,
  'dataset-rename': renameDataset,
  'dataset-remove': removeDataset,
  'reset-layout': resetLayout,
  'report-copy': copyReport,
  'report-txt': () => { if (lastResult) downloadText(reportText(lastResult), fileBaseName() + '-report.txt'); },
  'report-csv': () => { if (lastResult) downloadText(reportCsv(lastResult), fileBaseName() + '-report.csv', 'text/csv'); },
  help: (el) => showHelp(el.dataset.help, null),
};

/** Menu bar behaviour, like TGMenuBar. */
function initMenus() {
  const bar = $('menubar');
  const menus = [...bar.querySelectorAll('.menu')];
  const closeAll = () => menus.forEach((m) => m.classList.remove('open'));
  const anyOpen = () => menus.some((m) => m.classList.contains('open'));
  for (const m of menus) {
    const title = m.querySelector('.menu-title');
    title.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasOpen = m.classList.contains('open');
      closeAll();
      if (!wasOpen) m.classList.add('open');
    });
    title.addEventListener('mouseenter', () => { if (anyOpen()) { closeAll(); m.classList.add('open'); } });
    title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); title.click(); } });
    m.querySelector('.dropdown').addEventListener('click', () => closeAll());
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeAll(); hideHelp(); } });
}

// ================================================================ 12. wiring

function init() {
  initMenus();
  initResizers();
  for (const el of document.querySelectorAll('[data-action]')) {
    const fn = ACTIONS[el.dataset.action];
    if (fn) el.addEventListener('click', (ev) => { ev.stopPropagation(); fn(el); });
  }
  // "?" buttons
  for (const el of document.querySelectorAll('.help-btn')) {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); showHelp(el.dataset.help, el); });
  }
  $('help-pop').addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', hideHelp);

  // backend URL persists across visits (a setting, not part of a document)
  const savedUrl = storageGet(BACKEND_KEY);
  if (savedUrl) $('backend-url').value = savedUrl;
  $('backend-url').addEventListener('change', () => storageSet(BACKEND_KEY, backendUrl()));
  $('btn-health').addEventListener('click', checkHealth);

  // data columns and datasets
  for (const c of COLUMNS) $('col-' + c).addEventListener('input', updateCounts);
  $('dataset-select').addEventListener('change', (ev) => setActiveDataset(parseInt(ev.target.value, 10)));
  renderDatasetSelector();

  // the data table dialog
  const grid = $('grid');
  grid.addEventListener('paste', gridPaste);
  grid.addEventListener('keydown', gridKeydown);
  grid.addEventListener('input', updateTableCount);
  grid.addEventListener('click', (ev) => { if (ev.target.classList.contains('rowdel-btn')) gridDeleteRow(ev.target); });
  for (const el of document.querySelectorAll('[data-taction]')) {
    const fn = TABLE_ACTIONS[el.dataset.taction];
    if (fn) el.addEventListener('click', fn);
  }
  $('import-text').addEventListener('input', renderImportMapping);
  $('table-dialog').addEventListener('cancel', (ev) => { ev.preventDefault(); tableCancel(); });   // Escape = cancel

  // the "Examples…" dropdown fills formula, names and guesses
  $('quick-pick').addEventListener('change', (ev) => {
    const v = ev.target.value;
    if (!v) return;
    const [formula, names, guesses] = v.split('|');
    $('formula').value = formula;
    $('param-names').value = names || '';
    $('initial-guesses').value = guesses || '';
    ev.target.value = '';
    renderParamTable();
    autosave();
  });

  // parameter table <-> comma lists
  for (const id of ['formula', 'param-names', 'initial-guesses']) $(id).addEventListener('input', renderParamTable);
  $('param-table').addEventListener('input', paramTableToLists);
  renderParamTable();

  $('btn-fit').addEventListener('click', runFit);
  $('btn-png').addEventListener('click', exportPng);
  $('btn-table').addEventListener('click', openTable);
  $('btn-clear').addEventListener('click', clearEverything);

  // keyboard: Ctrl/Cmd+Enter runs the fit, Ctrl/Cmd+E opens the table
  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (ev.key === 'Enter' && !$('table-dialog').open) { ev.preventDefault(); runFit(); }
    if ((ev.key === 'e' || ev.key === 'E') && !$('table-dialog').open) { ev.preventDefault(); openTable(); }
  });

  // --- save / load ---
  $('btn-save').addEventListener('click', saveDocument);
  $('btn-load').addEventListener('click', openLoadDialog);
  $('btn-pick-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (ev) => {
    $('paste-dialog').close();
    loadDocumentFile(ev.target.files[0]);
    ev.target.value = '';
  });
  $('btn-paste-load').addEventListener('click', () => {
    const text = $('paste-area').value.trim();
    if (!text) return;
    if (loadDocumentText(text, 'pasted text')) $('paste-dialog').close();
  });

  // pasting a whole document anywhere outside a text box also loads it
  document.addEventListener('paste', (ev) => {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const text = (ev.clipboardData || window.clipboardData).getData('text');
    if (text && text.trim().startsWith('{')) { ev.preventDefault(); loadDocumentText(text, 'pasted text'); }
  });

  // drag a .json file anywhere onto the page
  let dragDepth = 0;
  const overlay = $('drop-overlay');
  document.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
    ev.preventDefault();
    dragDepth += 1;
    overlay.hidden = false;
  });
  document.addEventListener('dragover', (ev) => { if (!overlay.hidden) ev.preventDefault(); });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file) loadDocumentFile(file);
  });

  // --- autosave on every change, restore on load ---
  for (const el of document.querySelectorAll('.inputs input, .inputs textarea, .inputs select')) {
    el.addEventListener('input', autosave);
    if (el.type === 'checkbox' || el.tagName === 'SELECT') el.addEventListener('change', autosave);
  }
  restoreAutosave();
  checkHealth();
}

init();
