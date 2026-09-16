/*
 * app.js — all the behaviour of index.html.
 *
 * Sections:
 *   1. helpers            small utilities (element lookup, number formatting)
 *   2. data columns       turn pasted text into numbers, live point counts
 *   3. form <-> object    read the whole form into one object and back
 *   4. backend            talk to the Flask server (/health, /fit)
 *   5. fit report         render parameters, chi2, ndf, p-value as HTML
 *   5b. plot              load JSROOT from the CDN, draw the ROOT canvas, export PNG
 *   5c. documents         save / load JSON documents, autosave to localStorage
 *   6. wiring             connect buttons and inputs
 *
 * Plain JavaScript, loaded as an ordinary script (not a module) so the page
 * also works when opened straight from disk.
 */

'use strict';

// ---------------------------------------------------------------- 1. helpers

const $ = (id) => document.getElementById(id);

const DEFAULT_BACKEND = 'http://localhost:8000';
const BACKEND_KEY = 'rootfit.backendUrl';

/** Round `value` so that its uncertainty shows two significant figures,
 *  e.g. (1.97539, 0.045541) -> "1.975 ± 0.046". If there is no usable
 *  error, fall back to 6 significant figures. */
function fmtPair(value, error) {
  if (!Number.isFinite(value)) return String(value);
  if (!Number.isFinite(error) || error <= 0) return `${fmtNum(value)} ± ${fmtNum(error)}`;
  const digits = Math.max(0, 1 - Math.floor(Math.log10(error)));  // 2 sig figs on the error
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
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** Show a message above the plot. kind = 'error' | 'warn' | 'info' | '' (hide). */
function showMessage(kind, text) {
  const box = $('message');
  if (!kind) { box.hidden = true; box.textContent = ''; return; }
  box.className = 'message ' + kind;
  box.textContent = text;
  box.hidden = false;
}

// ---------------------------------------------------------------- 2. data columns

/** Parse one pasted column. Accepts one value per line, but also commas,
 *  semicolons, tabs or spaces between values, and ignores blank lines.
 *  Returns { values: [numbers], bad: [strings that were not numbers] }. */
function parseColumn(text) {
  const values = [];
  const bad = [];
  const tokens = String(text || '').split(/[\s,;]+/);
  for (const t of tokens) {
    if (t === '') continue;
    const v = Number(t);
    if (Number.isFinite(v)) values.push(v);
    else bad.push(t);
  }
  return { values, bad };
}

const COLUMNS = ['x', 'y', 'ex', 'ey'];

/** Update the little "n points" badges next to the four text areas and flag
 *  columns whose length does not match X. */
function updateCounts() {
  const nx = parseColumn($('col-x').value).values.length;
  for (const c of COLUMNS) {
    const { values, bad } = parseColumn($('col-' + c).value);
    const badge = $('count-' + c);
    badge.textContent = bad.length ? `${values.length} (+${bad.length} bad)` : String(values.length);
    const mismatch = bad.length > 0 || (values.length > 0 && values.length !== nx);
    badge.classList.toggle('mismatch', mismatch);
  }
}

/** Split "a, b, c" into ["a","b","c"], keeping empty slots so a user can
 *  write "1,,3" to leave the middle guess at ROOT's default. */
function splitList(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  return s.split(',').map((t) => t.trim());
}

// ---------------------------------------------------------------- 3. form <-> object

/** Everything the user typed, as one plain object. This is what gets saved
 *  in a document and autosaved to localStorage. */
function readForm() {
  return {
    data: {
      x: $('col-x').value, y: $('col-y').value,
      ex: $('col-ex').value, ey: $('col-ey').value,
    },
    formula: $('formula').value,
    param_names: $('param-names').value,
    initial_guesses: $('initial-guesses').value,
    graph_title: $('graph-title').value,
    x_title: $('x-title').value,
    y_title: $('y-title').value,
    options: {},                        // reserved for fit range etc. (milestone 2)
  };
}

function writeForm(inputs) {
  const d = (inputs && inputs.data) || {};
  $('col-x').value = d.x || '';
  $('col-y').value = d.y || '';
  $('col-ex').value = d.ex || '';
  $('col-ey').value = d.ey || '';
  $('formula').value = inputs.formula || '';
  $('param-names').value = inputs.param_names || '';
  $('initial-guesses').value = inputs.initial_guesses || '';
  $('graph-title').value = inputs.graph_title || '';
  $('x-title').value = inputs.x_title || '';
  $('y-title').value = inputs.y_title || '';
  updateCounts();
}

function clearForm() {
  writeForm({ formula: '[0]*x+[1]' });
  $('doc-title').value = '';
  $('doc-notes').value = '';
  $('report').innerHTML = '';
  $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
  $('btn-png').disabled = true;
  lastResult = null;
  lastDrawn = null;
  showMessage('');
}

/** Turn the form into the JSON body the backend expects. Throws an Error with
 *  a human-readable message if the data cannot be used. */
function buildPayload(inputs) {
  const cols = {};
  for (const c of COLUMNS) {
    const { values, bad } = parseColumn(inputs.data[c]);
    if (bad.length) {
      const label = { x: 'X', y: 'Y', ex: 'X errors', ey: 'Y errors' }[c];
      throw new Error(`${label}: "${bad[0]}" is not a number${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}.`);
    }
    cols[c] = values;
  }
  if (cols.x.length === 0) throw new Error('Paste some X values first.');
  if (cols.y.length === 0) throw new Error('Paste some Y values first.');
  if (cols.x.length !== cols.y.length) throw new Error(`X has ${cols.x.length} points but Y has ${cols.y.length}. They must match.`);
  if (cols.ex.length && cols.ex.length !== cols.x.length) throw new Error(`X errors: ${cols.ex.length} values for ${cols.x.length} points. Give one per point or leave the column empty.`);
  if (cols.ey.length && cols.ey.length !== cols.x.length) throw new Error(`Y errors: ${cols.ey.length} values for ${cols.x.length} points. Give one per point or leave the column empty.`);
  if (!inputs.formula.trim()) throw new Error('Type a fit function, e.g. [0]*x+[1].');

  return {
    x: cols.x, y: cols.y, ex: cols.ex, ey: cols.ey,
    formula: inputs.formula.trim(),
    param_names: splitList(inputs.param_names),
    initial_guesses: splitList(inputs.initial_guesses).map((g) => (g === '' ? null : g)),
    title: inputs.graph_title,
    x_title: inputs.x_title,
    y_title: inputs.y_title,
  };
}

// ---------------------------------------------------------------- 4. backend

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
      'If it runs on another machine, change the Backend URL under Settings.');
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
  setStatus(el, 'checking…', 'busy');
  try {
    const h = await callBackend('/health', {}, 8000);
    setStatus(el, `connected — ROOT ${h.root_version}`, 'ok');
  } catch (e) {
    setStatus(el, e.message.split('\n')[0], 'err');
  }
}

let lastResult = null;   // the last successful /fit response (used by save & export)

async function runFit() {
  showMessage('');
  let payload;
  try {
    payload = buildPayload(readForm());
  } catch (e) {
    showMessage('error', e.message);
    return;
  }

  const btn = $('btn-fit');
  btn.disabled = true;
  setStatus($('fit-status'), 'fitting…', 'busy');
  try {
    const result = await callBackend('/fit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    lastResult = result;
    renderReport(result);
    await drawPlot(result);
    autosave();
    if (!result.converged) {
      showMessage('warn', `The fit did not converge cleanly: ${result.status_message} Try better initial guesses.`);
    }
    setStatus($('fit-status'), 'done', 'ok');
  } catch (e) {
    showMessage('error', e.message);
    setStatus($('fit-status'), 'failed', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 5. fit report

function renderReport(r) {
  const rows = r.params.map((p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td class="num" title="${p.value} ± ${p.error}">${fmtPair(p.value, p.error)}</td>
      <td class="num fine">${fmtNum(p.value, 8)}</td>
      <td class="num fine">${fmtNum(p.error, 4)}</td>
    </tr>`).join('');

  const conv = r.converged
    ? `<span class="converged">✔ ${escapeHtml(r.status_message)}</span>`
    : `<span class="not-converged">✖ ${escapeHtml(r.status_message)}</span>`;

  $('report').innerHTML = `
    <h3>Fit report</h3>
    <p class="fine">Function: <code>${escapeHtml(r.formula)}</code> &nbsp; fitted over x ∈ [${fmtNum(r.range[0])}, ${fmtNum(r.range[1])}] &nbsp; ${r.n_points} points &nbsp; ${conv}</p>
    <table>
      <thead><tr><th>Parameter</th><th>Value ± uncertainty</th><th>full value</th><th>full error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="summary">
      <div class="stat"><div class="k">χ²</div><div class="v">${fmtNum(r.chi2)}</div></div>
      <div class="stat"><div class="k">NDF</div><div class="v">${r.ndf}</div></div>
      <div class="stat"><div class="k">χ² / NDF</div><div class="v">${r.chi2_ndf === null ? '—' : fmtNum(r.chi2_ndf, 4)}</div></div>
      <div class="stat"><div class="k">p-value</div><div class="v">${fmtNum(r.prob, 4)}</div></div>
    </div>
    <p class="fine">NDF = number of points − number of free parameters. χ²/NDF near 1 means the model describes the data within the quoted errors;
    the p-value is the probability of a χ² at least this large if the model were right. Without Y errors, χ² is in arbitrary units.</p>`;
}

// ---------------------------------------------------------------- 5b. plot (JSROOT)

// JSROOT is CERN's JavaScript library that understands ROOT objects. The
// backend sends the finished TCanvas (graph + fitted curve + stats box) as
// ROOT-JSON; JSROOT draws it exactly as ROOT would. Nothing about the plot is
// computed on this side.
//
// It is loaded on demand, as a classic <script> tag rather than an ES module:
// module imports are blocked when the page is opened from disk (file://), and
// a script tag works everywhere. The bundle defines a global "JSROOT" object.
// Two URLs are tried in case the CDN layout changes.
const JSROOT_URLS = [
  'https://root.cern/js/latest/build/jsroot.min.js',
  'https://root.cern/js/latest/build/jsroot.js',
];
let jsrootPromise = null;
let lastDrawn = null;   // { json, option } of the object on screen, for PNG export

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
      // Draw the fitted TF1 from the points ROOT itself evaluated (fSave),
      // instead of letting JSROOT re-evaluate the formula in JavaScript.
      m.settings.PreferSavedPoints = true;
      // Used only when a bare TGraph is drawn (no canvas from the backend):
      // show the fit box with p-value, chi2/ndf, errors, values.
      m.gStyle.fOptFit = 1111;
      m.gStyle.fOptStat = 0;
      return m;
    })().catch((e) => {
      jsrootPromise = null;                 // allow a retry next time
      throw new Error(`Could not load JSROOT from root.cern — are you online? (${e.message})`);
    });
  }
  return jsrootPromise;
}

/** Pick what to draw from a /fit response: the whole canvas if we have it,
 *  otherwise just the graph (which still carries the fitted function). */
function drawableFrom(result) {
  if (result && result.canvas_json) return { json: result.canvas_json, option: '' };
  if (result && result.graph_json) return { json: result.graph_json, option: 'AP' };
  return null;
}

async function drawPlot(result) {
  const plot = $('plot');
  const src = drawableFrom(result);
  $('btn-png').disabled = true;
  lastDrawn = null;
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
    // parse() resolves the "$ref" links inside ROOT-JSON. It modifies the
    // object it is given, so hand it a copy and keep the original for saving.
    const obj = jsroot.parse(JSON.stringify(src.json));
    const painter = await jsroot.draw(plot, obj, src.option);
    jsroot.registerForResize(painter);    // redraw when the window changes size
    lastDrawn = src;
    $('btn-png').disabled = false;
  } catch (e) {
    plot.innerHTML = `<p class="placeholder">JSROOT could not draw the result: ${escapeHtml(e.message)}</p>`;
  }
}

/** Ask JSROOT to render the current plot into a PNG and download it. */
async function exportPng() {
  if (!lastDrawn) return;
  const btn = $('btn-png');
  btn.disabled = true;
  try {
    const jsroot = await loadJSROOT();
    const obj = jsroot.parse(JSON.stringify(lastDrawn.json));   // fresh copy, not the on-screen one
    const dataUrl = await jsroot.makeImage({ format: 'png', object: obj, option: lastDrawn.option, width: 1200, height: 800 });
    if (!dataUrl) throw new Error('JSROOT returned no image.');
    downloadDataUrl(dataUrl, fileBaseName() + '.png');
  } catch (e) {
    showMessage('error', 'PNG export failed: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function downloadDataUrl(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** A safe file name from the document title (or graph title), e.g. "pendulum-lab-3". */
function fileBaseName() {
  const raw = ($('doc-title').value || $('graph-title').value || 'rootfit').trim();
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'rootfit';
}

// ---------------------------------------------------------------- 5c. documents (save / load / autosave)

// A "document" is one JSON file holding everything on the page: the inputs,
// the last fit result (including the ROOT canvas, so a loaded document can be
// redrawn without a backend) and some metadata. There is no server-side
// storage — this file is the only place your work lives.
const DOC_VERSION = 1;
const APP_VERSION = '0.1.0';
const AUTOSAVE_KEY = 'rootfit.autosave';
let documentCreated = null;   // "created" timestamp carried over from a loaded document

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
    results: lastResult,            // the full /fit response, or null if nothing was fitted
    backend_url: backendUrl(),      // for the record only; loading a document does not change your setting
  };
}

function saveDocument() {
  const text = JSON.stringify(buildDocument(), null, 1);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  downloadDataUrl(url, fileBaseName() + '.json');
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showMessage('info', 'Document saved to your downloads folder.');
}

/** Put a parsed document onto the page. Throws with a readable message if the
 *  object is not one of ours. */
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
  showMessage('');
  if (lastResult) {
    renderReport(lastResult);
    drawPlot(lastResult);           // async; the plot fills in when JSROOT is ready
  } else {
    $('report').innerHTML = '';
    $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
    $('btn-png').disabled = true;
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

// --- autosave: the current page state goes to localStorage a moment after
// --- every change, and comes back when the page is reopened.
let autosaveTimer = null;
function autosaveNow() {
  autosaveTimer = null;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildDocument()));
  } catch (_) {
    // storage full or unavailable: try again without the (large) results
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...buildDocument(), results: null })); } catch (__) { /* give up quietly */ }
  }
}
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, 400);   // wait for typing to pause
}
// if the tab is closed or reloaded while a save is pending, write it now
window.addEventListener('pagehide', () => { if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveNow(); } });

function restoreAutosave() {
  let text = null;
  try { text = localStorage.getItem(AUTOSAVE_KEY); } catch (_) { return false; }
  if (!text) return false;
  try {
    applyDocument(JSON.parse(text));
    showMessage('info', 'Restored your previous session from this browser (autosave). Use "Save document" to keep a file.');
    return true;
  } catch (_) {
    return false;
  }
}

function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- 6. wiring

function init() {
  // backend URL persists across visits (a setting, not part of a document)
  try {
    const saved = localStorage.getItem(BACKEND_KEY);
    if (saved) $('backend-url').value = saved;
  } catch (_) { /* localStorage may be unavailable */ }
  $('backend-url').addEventListener('change', () => {
    try { localStorage.setItem(BACKEND_KEY, backendUrl()); } catch (_) { /* ignore */ }
  });
  $('btn-health').addEventListener('click', checkHealth);

  for (const c of COLUMNS) $('col-' + c).addEventListener('input', updateCounts);
  updateCounts();

  // the "Examples…" dropdown fills formula, names and guesses
  $('quick-pick').addEventListener('change', (ev) => {
    const v = ev.target.value;
    if (!v) return;
    const [formula, names, guesses] = v.split('|');
    $('formula').value = formula;
    $('param-names').value = names || '';
    $('initial-guesses').value = guesses || '';
    ev.target.value = '';
  });

  $('btn-fit').addEventListener('click', runFit);
  $('btn-png').addEventListener('click', exportPng);
  $('btn-clear').addEventListener('click', () => {
    if (confirm('Clear the whole form? (Save the document first if you want to keep it.)')) {
      clearForm();
      documentCreated = null;
      clearAutosave();
    }
  });

  // Ctrl/Cmd+Enter anywhere in the form runs the fit
  $('btn-fit').closest('.inputs').addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); runFit(); }
  });

  // --- save / load ---
  $('btn-save').addEventListener('click', saveDocument);
  $('btn-load').addEventListener('click', () => { $('paste-area').value = ''; $('paste-dialog').showModal(); });
  $('btn-pick-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (ev) => {
    $('paste-dialog').close();
    loadDocumentFile(ev.target.files[0]);
    ev.target.value = '';                 // so choosing the same file again fires "change"
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
  for (const el of document.querySelectorAll('.inputs input, .inputs textarea')) {
    if (el.id === 'backend-url') continue;
    el.addEventListener('input', autosave);
  }
  restoreAutosave();
}

init();
