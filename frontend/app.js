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
 *   5d. menus             menu bar, dialogs, built-in examples
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
  clearReport();
  $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
  setPngEnabled(false);
  lastResult = null;
  lastDrawn = null;
  showMessage('');
  setStatus($('fit-status'), 'Ready');
}

/** The PNG export lives in two places (toolbar button and File menu). */
function setPngEnabled(on) {
  $('btn-png').disabled = !on;
  for (const el of document.querySelectorAll('[data-needs-plot]')) el.disabled = !on;
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
  setStatus(el, 'Backend: checking', 'busy');
  try {
    const h = await callBackend('/health', {}, 8000);
    setStatus(el, `Backend: connected, ROOT ${h.root_version}`, 'ok');
  } catch (e) {
    setStatus(el, 'Backend: ' + e.message.split('\n')[0], 'err');
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
  setStatus($('fit-status'), 'Fitting', 'busy');
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
    setStatus($('fit-status'), 'Fit done', 'ok');
  } catch (e) {
    showMessage('error', e.message);
    setStatus($('fit-status'), 'Fit failed', 'err');
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
      <td class="num">${fmtNum(p.value, 8)}</td>
      <td class="num">${fmtNum(p.error, 4)}</td>
    </tr>`).join('');

  const conv = r.converged
    ? `<span class="converged">${escapeHtml(r.status_message)}</span>`
    : `<span class="not-converged">${escapeHtml(r.status_message)}</span>`;

  $('report').innerHTML = `
    <p>Function <code>${escapeHtml(r.formula)}</code>, fitted over x ∈ [${fmtNum(r.range[0])}, ${fmtNum(r.range[1])}], ${r.n_points} points. ${conv}</p>
    <table class="report-table">
      <thead><tr><th>Parameter</th><th>Value ± uncertainty</th><th>Full value</th><th>Full error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="summary">
      <div class="stat"><span class="k">χ²</span><span class="v">${fmtNum(r.chi2)}</span></div>
      <div class="stat"><span class="k">NDF</span><span class="v">${r.ndf}</span></div>
      <div class="stat"><span class="k">χ² / NDF</span><span class="v">${r.chi2_ndf === null ? '—' : fmtNum(r.chi2_ndf, 4)}</span></div>
      <div class="stat"><span class="k">p-value</span><span class="v">${fmtNum(r.prob, 4)}</span></div>
    </div>
    <p class="fine">NDF = number of points − number of free parameters. χ²/NDF near 1 means the model describes the data within the quoted errors;
    the p-value is the probability of a χ² at least this large if the model were right. Without Y errors, χ² is in arbitrary units.</p>`;
}

function clearReport() {
  $('report').innerHTML = '<p class="placeholder-text">No fit yet.</p>';
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
  setPngEnabled(false);
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
    setPngEnabled(true);
    setStatus($('jsroot-status'), `JSROOT ${jsroot.version}`);
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

// ---------------------------------------------------------------- 5d. menus, dialogs, examples

// The three example documents from examples/, embedded so the Fit menu can load
// them even when the page is opened from disk (a file:// page cannot fetch files).
const EXAMPLES = {
  linear: {
    title: "Straight line (reference dataset)",
    notes: "Same data as tests/linear_reference.json. Expected: slope 1.975 \u00b1 0.046, intercept 0.23 \u00b1 0.18, chi2/NDF = 2.10/6.",
    inputs: {"data": {"x": "1\n2\n3\n4\n5\n6\n7\n8", "y": "2.3\n4.1\n6.2\n7.9\n10.3\n11.8\n14.1\n16.2", "ex": "", "ey": "0.2\n0.2\n0.3\n0.3\n0.3\n0.4\n0.4\n0.4"}, "formula": "[0]*x+[1]", "param_names": "slope, intercept", "initial_guesses": "1, 0", "graph_title": "Straight line", "x_title": "x", "y_title": "y", "options": {}},
  },
  exp: {
    title: "Exponential decay with background",
    notes: "Counts vs time. Poisson errors on y (sqrt N), 0.05 s timing error on x. Try the same fit without the [2] background term and compare chi2/NDF.",
    inputs: {"data": {"x": "0\n0.5\n1\n1.5\n2\n2.5\n3\n3.5\n4\n4.5\n5\n5.5\n6\n6.5\n7\n7.5\n8\n8.5\n9\n9.5\n10", "y": "990\n838\n688.7\n563.5\n482.8\n396.1\n353.9\n323.1\n248.1\n210.2\n195.8\n168.5\n144.2\n115.1\n110.8\n106\n76.4\n76.67\n57.55\n57.51\n48.74", "ex": "0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05\n0.05", "ey": "31.5\n28.8\n26.4\n24.2\n22.2\n20.4\n18.8\n17.3\n16\n14.8\n13.8\n12.8\n12\n11.2\n10.5\n9.95\n9.44\n8.99\n8.6\n8.26\n7.96"}, "formula": "[0]*exp(-x/[1])+[2]", "param_names": "N0, tau, background", "initial_guesses": "1000, 2, 10", "graph_title": "Decay curve", "x_title": "t (s)", "y_title": "counts", "options": {}},
  },
  gaus: {
    title: "Gaussian peak on flat background",
    notes: "Uses ROOT's named functions: gaus(0) takes parameters 0-2, pol0(3) takes parameter 3. Because this is a SUM of named functions, ROOT does not compute starting values for it (it only does that for a lone gaus/expo/landau/polN), so the guesses matter: read the peak height (~120), position (~10) and width (~1.5) off the plot and the background (~15) from the flat part. Try clearing the guesses to see how the fit collapses to a flat line.",
    inputs: {"data": {"x": "0\n0.5\n1\n1.5\n2\n2.5\n3\n3.5\n4\n4.5\n5\n5.5\n6\n6.5\n7\n7.5\n8\n8.5\n9\n9.5\n10\n10.5\n11\n11.5\n12\n12.5\n13\n13.5\n14\n14.5\n15\n15.5\n16\n16.5\n17\n17.5\n18\n18.5\n19\n19.5\n20", "y": "14.09\n10.09\n16.05\n15.61\n14.28\n5.253\n12.92\n14.83\n15.49\n9.209\n13.62\n12.38\n14.79\n27.14\n24.93\n40.74\n64.42\n73.55\n100.1\n122.1\n133.6\n119.9\n124.9\n119.5\n69.12\n68.37\n44.69\n27.65\n32.93\n22.13\n11.72\n15.9\n17.46\n14.33\n17.67\n14.75\n17.59\n20.57\n12.38\n15.79\n13.21", "ex": "", "ey": "3.87\n3.87\n3.87\n3.87\n3.87\n3.87\n3.87\n3.87\n3.88\n3.89\n3.94\n4.04\n4.27\n4.71\n5.41\n6.4\n7.6\n8.87\n10.1\n11\n11.5\n11.6\n11.1\n10.3\n9.12\n7.85\n6.63\n5.59\n4.82\n4.34\n4.07\n3.95\n3.9\n3.88\n3.88\n3.87\n3.87\n3.87\n3.87\n3.87\n3.87"}, "formula": "gaus(0)+pol0(3)", "param_names": "amplitude, mean, sigma, background", "initial_guesses": "120, 10, 1.5, 15", "graph_title": "Spectrum", "x_title": "channel", "y_title": "counts", "options": {}},
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
  clear: clearEverything,
  fit: runFit,
  example: (el) => loadExample(el.dataset.example),
  settings: openSettings,
  health: checkHealth,
  about: openAbout,
};

/** Menu bar behaviour, like TGMenuBar: click a title to open, move across
 *  titles while one is open, click anywhere else or press Escape to close. */
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
    m.querySelector('.dropdown').addEventListener('click', () => closeAll());   // an item was chosen
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeAll(); });
}

// ---------------------------------------------------------------- 6. wiring

function init() {
  initMenus();
  for (const el of document.querySelectorAll('[data-action]')) {
    const fn = ACTIONS[el.dataset.action];
    if (fn) el.addEventListener('click', () => fn(el));
  }

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
  $('btn-clear').addEventListener('click', clearEverything);

  // Ctrl/Cmd+Enter anywhere in the form runs the fit
  $('btn-fit').closest('.inputs').addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); runFit(); }
  });

  // --- save / load ---
  $('btn-save').addEventListener('click', saveDocument);
  $('btn-load').addEventListener('click', openLoadDialog);
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
  checkHealth();                        // fill the status bar right away
}

init();
