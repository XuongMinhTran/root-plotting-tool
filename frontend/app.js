/*
 * app.js - shared behavior for classic.html and modern.html.
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

const DEFAULT_BACKEND = 'https://root-plotting-tool.onrender.com';
const RENDER_BACKEND = 'https://root-plotting-tool.onrender.com';
const LOCAL_BACKEND = 'http://localhost:8000';
const BACKEND_KEY = 'rootfit.backendUrl';

// When the backend serves these pages itself (the one-port setup started by
// ./start), the API lives on this same origin. When the page comes from
// file:// or a separate static server, fall back to the standalone backend.
// resolveBackend() decides once at start-up; an explicit setting always wins.
let resolvedBackend = null;

async function resolveBackend() {
  const saved = (storageGet(BACKEND_KEY) || '').trim();
  if (saved) { resolvedBackend = saved.replace(/\/+$/, ''); return resolvedBackend; }
  const origin = window.location?.origin || '';
  if (/^https?:$/.test(window.location?.protocol || '') && origin && origin !== 'null') {
    try {
      const probe = await fetch(origin + '/health', { signal: AbortSignal.timeout(4000) });
      if (probe.ok) { resolvedBackend = origin.replace(/\/+$/, ''); return resolvedBackend; }
    } catch (e) { /* not served by the backend; use the default below */ }
  }
  resolvedBackend = DEFAULT_BACKEND;
  return resolvedBackend;
}
const LAYOUT_KEY = 'rootfit.layout' + (window.location?.pathname.endsWith('/modern.html') ? '.modern' : '');

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
  document.dispatchEvent(new CustomEvent('rootfit:message', { detail: { kind } }));
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

/** Modal prompts use the active interface's dialog styles and native focus handling. */
let dialogSequence = 0;
function askDialog({title, message = '', label, value = '', accept = 'OK', cancel = 'Cancel', destructive = false, emphasizeMessage = false, primaryCancel = false, validate}) {
  return new Promise(resolve => {
    const id = `app-dialog-${++dialogSequence}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'tframe app-dialog' + (emphasizeMessage ? ' save-notice' : '');
    dialog.setAttribute('aria-labelledby', id + '-title');
    dialog.setAttribute('aria-describedby', id + '-message');
    dialog.innerHTML = `<form novalidate>
      <div class="titlebar" id="${id}-title"></div>
      <div class="dialog-body">
        <p id="${id}-message" class="dialog-message"></p>
        <div class="field" ${label ? '' : 'hidden'}>
          <label for="${id}-input"></label>
          <input id="${id}-input" type="text" autocomplete="off" spellcheck="false" aria-describedby="${id}-error">
        </div>
        <p id="${id}-error" class="dialog-error" role="alert" hidden></p>
        <div class="row actions">
          <button type="submit" class="${destructive ? 'danger' : 'primary'}"></button>
          <button type="button" class="dialog-cancel">Cancel</button>
        </div>
      </div>
    </form>`;
    const input = dialog.querySelector('input');
    const error = dialog.querySelector('.dialog-error');
    dialog.querySelector('.titlebar').textContent = title;
    dialog.querySelector('.dialog-message').textContent = message;
    dialog.querySelector('.dialog-message').hidden = !message;
    dialog.querySelector('label').textContent = label || '';
    dialog.querySelector('[type="submit"]').textContent = accept;
    if (primaryCancel) {
      dialog.querySelector('[type="submit"]').classList.remove('primary');
      dialog.querySelector('.dialog-cancel').classList.add('primary');
    }
    input.value = value;
    dialog.querySelector('.dialog-cancel').textContent = cancel || '';
    dialog.querySelector('.dialog-cancel').hidden = !cancel;
    let answer = null;
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        answer = label ? (validate ? validate(input.value) : input.value.trim()) : true;
        dialog.close();
      } catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    });
    input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); });
    dialog.querySelector('.dialog-cancel').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); }, {once:true});
    document.body.appendChild(dialog);
    dialog.showModal();
    if (label) { input.focus(); input.select(); }
    else dialog.querySelector(destructive || primaryCancel ? '.dialog-cancel' : '[type="submit"]').focus();
  });
}

// Remember acknowledgement across interfaces, but repeat the reminder after a reload.
const SAVE_NOTICE_KEY = 'rootfit.saveNoticeSeen.v1';
async function showFirstVisitSaveNotice() {
  const navigation = window.performance?.getEntriesByType?.('navigation')?.[0];
  const reloaded = navigation ? navigation.type === 'reload' : window.performance?.navigation?.type === 1;
  if (!reloaded && storageGet(SAVE_NOTICE_KEY) === '1') return;
  await askDialog({
    title: 'Save your analysis',
    message: 'Your data is not saved to a file automatically. Use Save to keep your data, fit settings, and results. Browser autosave is not a permanent backup.',
    accept: 'Understood', cancel: null, emphasizeMessage: true,
  });
  storageSet(SAVE_NOTICE_KEY, '1');
}

function requestDatasetName(value) {
  return askDialog({title:'Rename dataset', label:'Dataset name', value, accept:'Rename',
    validate: name => { if (!name.trim()) throw new Error('Enter a dataset name.'); return name.trim(); }});
}
function confirmDatasetDeletion(name, n, unit = 'points') {
  return askDialog({title:'Delete dataset', message:`Delete “${name}” (${n} ${unit}) and its fit settings, results, and dependent calculations from the shared session?`, accept:'Delete', destructive:true});
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
  histogram_data: {
    title: 'Entering histogram data',
    html: `<p>Choose individual measurements to create bins, or pre-binned counts when the binning is already known. Separate values with spaces, commas, tabs or new lines.</p>
      <p>Pre-binned counts require one more edge than counts: edges 0, 1, 3 describe two bins, [0, 1) and [1, 3]. The last right edge is included. Counts must be nonnegative whole numbers, before weighting or background subtraction.</p>
      <p>For measurements, leave the bin count blank to use the range width, rounded up to a whole number (at least one bin). The range comes from the measurements unless you enter limits. You can also enter a bin count or custom edges. Measurements outside the edges are counted separately. The plot shows counts divided by bin width, so unequal-width bins remain comparable.</p>
      <p>Use Plot histogram to inspect the distribution without a fit. To fit it, choose a function and a histogram fitting method in Fit settings.</p>`,
  },
  histogram_report: {
    title: 'Histogram fit results',
    html: `<p>The fitted function is a count density. ROOT integrates it over each selected bin to predict that bin’s count. A fit range selects bins by their centers and includes the full selected bins.</p>
      <p>Poisson likelihood includes empty bins. Its report shows Poisson deviance, not a least-squares χ²; no χ² p-value is reported because that approximation may be unreliable for sparse counts.</p>
      <p>χ² uses √count uncertainties and excludes empty bins. Its p-value relies on the usual χ² approximation. Prefer Poisson likelihood when counts are small.</p>
      <p>Optional diagnostics compare counts with integrated predictions, even though the main plot displays counts per unit X. Convergence alone does not establish that the model describes the data.</p>`,
  },
  data: {
    title: 'Entering data',
    html: `
      <p>Each column holds one number per point. Paste straight from a spreadsheet: values separated by new lines,
      commas, tabs, semicolons or spaces are all accepted, and blank lines are ignored.</p>
      <p><b>Errors are optional.</b> Enter one value to apply it to every point on that axis, or one per point. Leave both error columns empty for an <em>unweighted</em> fit: every point counts
      the same, and the reported χ² is then in arbitrary units (its absolute value means nothing, only the shape of
      the fit does). With Y errors, each point is weighted by 1/σ<sub>y</sub>², which is what makes χ² and the parameter
      uncertainties meaningful.</p>
      <p><b>X errors</b> are folded in by ROOT's "effective variance" method: σ²<sub>eff</sub> = σ<sub>y</sub>² + (f′(x)·σ<sub>x</sub>)²,
      i.e. an uncertainty in x is turned into an equivalent uncertainty in y using the slope of the fitted curve.</p>
      <p><b>Several datasets</b> (x1 y1, x2 y2, …) can live in one document - use +, and switch with the selector.
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
    title: 'Initial guesses',
    html: `
      <p>Initial guesses specify the parameter values used to initialize minimization. Enter values in parameter-index order: <code>[0]</code>, <code>[1]</code>, …, using the units defined by the model.</p>
      <p>For <code>[0]*exp(-x/[1])</code>, [0] is the amplitude at x = 0 and [1] is the decay time constant. For <code>gaus</code>, the parameters are peak height, mean, and standard deviation.</p>
      <p>Blank entries retain the model’s default or automatic estimate. Automatic initialization depends on the function and analysis type; custom functions may require explicit guesses. In a comma-separated list, <code>1,,3</code> specifies [0] and [2] while leaving [1] unspecified.</p>
      <p>For nonlinear models, different initial guesses may converge to different local minima. Check the fit status, parameter uncertainties, and residuals.</p><p><a href="docs-starting-values.html" target="_blank" rel="noopener"><b>Starting parameter guides</b> - a recipe for every model</a></p>`,
  },
  range: {
    title: 'Fit range',
    html: `
      <p>By default the function is fitted to every point. Give a range to use only the points with
      x<sub>min</sub> ≤ x ≤ x<sub>max</sub> - for instance to fit the linear part of a curve, or to exclude a region where
      your model does not apply. The curve is still drawn only over the fitted range, so you can see what was used.</p>
      <p>NDF changes accordingly: it is the number of points <em>inside</em> the range minus the number of parameters.</p>`,
  },
  plot: {
    title: 'Plot options',
    html: `
      <p><b>Log axes</b> are applied to the ROOT canvas; points with zero or negative values cannot be shown on a log axis.
      A straight line on a log-Y plot is an exponential; on log-log it is a power law.</p>
      <p><b>Grid</b> draws dotted lines at the major ticks.</p>
      <p><b>Optional plots.</b> Select any combination of residuals, pulls, data/fit ratio, percentage difference, and a residual histogram. They are all off by default.</p>
      <p>Residuals show data − fit; pulls divide that difference by the effective measurement uncertainty. The ratio is data / fit and percentage difference is 100 × (data − fit) / fit. The histogram counts residuals in bins.</p>
      <p>These are diagnostics with the fitted curve held fixed, not uncertainty bands for the model. Points where a diagnostic is undefined are omitted with a message.</p>
      <p><b>Advanced optional plot settings</b> lets you rename each panel, set axis labels and Y limits, choose its height and point range, and adjust the grid, uncertainty bars, reference line, or histogram bins. Settings are saved with the document. Fit again to apply changes.</p>`,
  },
  report: {
    title: 'Fit statistics',
    html: `
      <p><b>Value ± uncertainty</b>: fitted parameter and its standard uncertainty from the parameter covariance matrix. Displayed uncertainties have two significant figures; the adjacent columns retain additional precision.</p>
      <p><b>χ²</b>: the sum of squared residuals divided by their variances. When X uncertainties are supplied, ROOT includes their contribution through the model derivative.</p>
      <p><b>NDF</b>: number of fitted points minus the number of free parameters.</p>
      <p><b>χ²/NDF</b>: reduced chi-square. Interpretation requires an appropriate model and uncertainty estimates; a value near one does not by itself establish model validity.</p>
      <p><b>p-value</b>: the upper-tail probability of the observed χ² under the assumed model and error distribution.</p>
      <p><b>Status</b>: minimizer convergence status. Convergence alone does not establish model validity or reliable parameter uncertainties; inspect the covariance and diagnostics.</p>
      <p><b>Residuals</b>: measured Y minus the model prediction. Pulls divide this difference by the effective measurement uncertainty.</p>`,
  },
};

let helpOpen = null;

function showHelp(key, anchor) {
  if (key === 'data' && $('analysis-type').value === 'histogram') key = 'histogram_data';
  if (key === 'report' && lastResult?.analysis_type === 'histogram') key = 'histogram_report';
  const pop = $('help-pop');
  const h = HELP[key];
  if (!h) return;
  if (helpOpen === key && !pop.hidden) { hideHelp(); return; }
  let bodyHtml = h.html;
  if (key === 'guesses' && window.ModelLibrary && window.ModelLibrary.guideFor) {
    const g = window.ModelLibrary.guideFor($('formula') ? $('formula').value : '');
    if (g && g.guide && g.guide.length) {
      bodyHtml = `<div class="help-model-guide"><p class="help-model-name">Starting values for <b>${escapeHtml(g.name)}</b></p><ul>${g.guide.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>` + bodyHtml;
    }
  }
  pop.innerHTML = `<div class="help-title">${h.title}<button type="button" class="help-close" aria-label="Close">×</button></div><div class="help-body">${bodyHtml}</div>`;
  pop.hidden = false;
  helpOpen = key;
  pop.querySelector('.help-close').addEventListener('click', hideHelp);
  // position: under the anchor if there is one, else centered
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

// ROOT's classic colors: kBlack, kRed, kBlue, kGreen+2, kMagenta+1, kOrange+7, kCyan+2, kBrown
const DATASET_COLORS = ['#000000', '#d62728', '#1f5fbf', '#2a8f3c', '#8e44ad', '#e08a00', '#17a2b8', '#7f4f24'];
const COLUMNS = ['x', 'y', 'ex', 'ey'];
const COLUMN_LABEL = { x: 'X', y: 'Y', ex: 'X errors', ey: 'Y errors' };

let datasets = [newDataset('Dataset 1', '')];
let activeIdx = 0;

function defaultFitSettings() { return {formula:'[0]*x+[1]', param_names:'', initial_guesses:'', x_min:'', x_max:''}; }
function normalizeFitSettings(settings = {}) {
  const defaults = defaultFitSettings();
  const fit = Object.fromEntries(Object.keys(defaults).map(key => [key, String(settings[key] ?? defaults[key])]));
  if (settings.equation && typeof settings.equation === 'object' && settings.equation.formula === fit.formula) {
    fit.equation = JSON.parse(JSON.stringify(settings.equation));
  }
  return fit;
}
function newDataset(name, type = 'xy') {
  const fit = defaultFitSettings();
  if (type === 'histogram') Object.assign(fit, {formula:'gausn', param_names:'norm, mean, sigma'});
  const d = {id:window.WorkspaceStore?.id(), name, analysis_type:type, x:'', y:'', ex:'', ey:'', fit};
  if (type === 'multivariate' && window.Multivariate) d.mv = window.Multivariate.defaultMv();
  return d;
}
function readDatasetFit() {
  const fit = {formula:$('formula').value, param_names:$('param-names').value,
    initial_guesses:$('initial-guesses').value, x_min:$('fit-xmin').value, x_max:$('fit-xmax').value};
  const equation = window.RootEquationEditor?.snapshot() || datasets[activeIdx]?.fit?.equation;
  if (equation && equation.formula === fit.formula) fit.equation = JSON.parse(JSON.stringify(equation));
  return fit;
}
function syncDatasetFit() {
  datasets[activeIdx].fit = readDatasetFit();
}
function writeDatasetFit(settings) {
  const fit = normalizeFitSettings(settings);
  for (const [key,id] of Object.entries({formula:'formula',param_names:'param-names',initial_guesses:'initial-guesses',x_min:'fit-xmin',x_max:'fit-xmax'})) $(id).value = fit[key];
  window.RootEquationEditor?.load(fit);
  renderParamTable();
}
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

const HISTOGRAM_FIELDS = ['source', 'samples', 'counts', 'bins', 'min', 'max', 'edges', 'method'];
function readHistogramControls() {
  return Object.fromEntries(HISTOGRAM_FIELDS.map(key => [key, $('hist-' + key).value]));
}
// Presets are shared by both interfaces; changing analysis type only changes the menu.
const FUNCTION_EXAMPLES = {
  "xy": [
    [
      "Straight line  [0]*x+[1]",
      "[0]*x+[1]",
      "slope, intercept",
      "1, 0"
    ],
    [
      "Quadratic  pol2",
      "pol2",
      "a, b, c",
      ""
    ],
    [
      "Exponential decay  [0]*exp(-x/[1])",
      "[0]*exp(-x/[1])",
      "amplitude, tau",
      "1, 1"
    ],
    [
      "Saturating rise  [0]*(1-TMath::Exp(-x/[1]))",
      "[0]*(1-TMath::Exp(-x/[1]))",
      "A, tau",
      "1, 1"
    ],
    [
      "Gaussian  gaus",
      "gaus",
      "constant, mean, sigma",
      ""
    ],
    [
      "Normalized Gaussian (area)  gausn",
      "gausn",
      "norm, mean, sigma",
      ""
    ],
    [
      "Gaussian + flat background  gaus(0)+pol0(3)",
      "gaus(0)+pol0(3)",
      "constant, mean, sigma, background",
      ""
    ],
    [
      "Exponential  expo",
      "expo",
      "constant, slope",
      ""
    ],
    [
      "Landau  landau",
      "landau",
      "constant, mpv, sigma",
      ""
    ],
    [
      "Sine  [0]*sin([1]*x+[2])+[3]",
      "[0]*sin([1]*x+[2])+[3]",
      "amplitude, omega, phase, offset",
      "1, 1, 0, 0"
    ],
    [
      "Power law  [0]*pow(x,[1])",
      "[0]*pow(x,[1])",
      "A, n",
      "1, 1"
    ]
  ],
  "histogram": [
    [
      "Gaussian (area)  gausn",
      "gausn",
      "norm, mean, sigma",
      ""
    ],
    [
      "Gaussian (peak height)  gaus",
      "gaus",
      "height, mean, sigma",
      ""
    ],
    [
      "Gaussian + flat background",
      "gaus(0)+pol0(3)",
      "height, mean, sigma, background",
      ""
    ],
    [
      "Landau  landau",
      "landau",
      "amplitude, location, width",
      ""
    ],
    [
      "Exponential  expo",
      "expo",
      "log amplitude, slope",
      ""
    ],
    [
      "Constant background  pol0",
      "pol0",
      "background",
      ""
    ]
  ]
};
let functionExamplesMode = null;
function syncFunctionExamples(histogram) {
  const mode = histogram ? 'histogram' : 'xy';
  if (functionExamplesMode === mode) return;
  const select = $('quick-pick');
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = histogram ? 'Histogram functions…' : 'Examples…';
  select.appendChild(placeholder);
  for (const [label, formula, names, guesses] of FUNCTION_EXAMPLES[mode]) {
    const option = document.createElement('option');
    option.value = [formula, names, guesses].join('|');
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = '';
  functionExamplesMode = mode;
}
function applyFunctionExample(value) {
  if (!value) return;
  const [formula, names, guesses] = value.split('|');
  $('formula').value = formula;
  $('param-names').value = names || '';
  $('initial-guesses').value = $('analysis-type').value !== 'histogram' && formula === '[0]*exp(-x/[1])'
    ? decayStartingGuesses(readForm()) || guesses || '' : guesses || '';
  $('quick-pick').value = '';
  syncDatasetFit();
  window.RootEquationEditor?.fromRoot();
  renderParamTable();
  autosave();
}

function syncAnalysisControls() {
  const type = $('analysis-type').value;
  const histogram = type === 'histogram';
  $('btn-histogram').disabled = !histogram || fitBusy;
  for (const id of ['dataset-select', 'fit-dataset-select', 'btn-fit', 'modern-next']) {
    const el = $(id); if (el) el.disabled = !type || (id === 'btn-fit' && fitBusy);
  }
  for (const el of document.querySelectorAll('[data-action="dataset-duplicate"], [data-action="dataset-rename"]')) el.disabled = !type;
  syncFunctionExamples(histogram);
  const samples = $('hist-source').value === 'samples';
  const multivariate = type === 'multivariate';
  $('xy-data').hidden = type !== 'xy';
  $('histogram-data').hidden = !histogram;
  if ($('multivariate-data')) $('multivariate-data').hidden = !multivariate;
  if ($('multivariate-model')) $('multivariate-model').hidden = !multivariate;
  if ($('single-fit-block')) $('single-fit-block').hidden = multivariate;
  $('hist-fit-options').hidden = !histogram;
  $('hist-samples-group').hidden = !samples;
  $('hist-counts-group').hidden = samples;
  $('hist-binning').hidden = !samples;
  $('hist-bins-help').hidden = !samples;
  if (!samples) $('hist-edges-details').open = true;
  const custom = !!$('hist-edges').value.trim();
  for (const id of ['hist-bins', 'hist-min', 'hist-max']) $(id).disabled = custom;
  for (const button of document.querySelectorAll('[data-action="table"], #btn-table')) button.disabled = type !== 'xy';
  const values = parseColumn($(samples ? 'hist-samples' : 'hist-counts').value);
  $('hist-summary').textContent = values.bad.length ? `${values.bad.length} entries need a number.` : samples ? `${values.values.length} measurements entered.` : `${values.values.length} bin counts entered.`;
  // Keep the XY-specific introduction out of histogram mode.
  const intro = document.querySelector('#panel-data .section-description');
  if (intro) intro.textContent = !type ? 'Select an analysis type to get started.' : histogram ? 'Enter individual measurements to group into bins, or provide existing bin edges and counts.' : 'Paste columns from a spreadsheet, or use the table editor to enter several columns at once. Each point needs an X and a Y value.';
  if (intro && multivariate) intro.textContent = 'Enter each input and output as a column, give one model per output with inputs x0, x1, … and shared parameters [0], [1], …, then Fit.';
}
function buildHistogramPayload(inputs, fitModel = true) {
  const h = inputs.histogram || {}, options = inputs.options || {};
  const histogram = {source:h.source || 'samples', method:h.method || 'poisson'};
  for (const key of ['samples', 'counts', 'edges']) {
    // Preserve inactive input in documents, but do not send it for analysis.
    if ((key === 'samples' && histogram.source !== 'samples') || (key === 'counts' && histogram.source !== 'counts')) continue;
    const parsed = parseColumn(h[key] || '');
    if (parsed.bad.length) throw new Error(`Histogram ${key}: "${parsed.bad[0]}" needs a finite number.`);
    histogram[key] = parsed.values;
  }
  if (histogram.source === 'samples') {
    if (!histogram.samples.length) throw new Error('Enter measurements before plotting the histogram.');
    if (!histogram.edges.length) {
      if (String(h.bins ?? '').trim()) {
        histogram.bins = Number(h.bins);
        if (!Number.isInteger(histogram.bins) || histogram.bins < 1 || histogram.bins > 2000) throw new Error('Enter a whole number of bins from 1 to 2000, or leave it blank to use the range width.');
      }
      const lo = numberOrNull(h.min), hi = numberOrNull(h.max);
      if (lo !== null || hi !== null) {
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) throw new Error('Histogram range: enter both limits, with the lower one first, or leave both blank.');
        histogram.range = [lo,hi];
      }
    }
  } else {
    if (!histogram.counts.length) throw new Error('Enter bin counts before plotting the histogram.');
    if (histogram.counts.some(v => v < 0 || !Number.isInteger(v))) throw new Error('Use nonnegative whole counts, before normalization or background subtraction.');
    if (histogram.edges.length !== histogram.counts.length + 1) throw new Error(`${histogram.counts.length} bin counts need ${histogram.counts.length + 1} edges.`);
  }
  if (histogram.edges.length && (histogram.edges.length < 2 || histogram.edges.some((v,i,a) => i && v <= a[i-1]))) throw new Error('Enter at least two bin edges in strictly increasing order.');
  if (fitModel && !inputs.formula.trim()) throw new Error('Choose a histogram fit function, such as gaus, or use Plot histogram without a fit.');
  const lo = fitModel ? numberOrNull(options.x_min) : null, hi = fitModel ? numberOrNull(options.x_max) : null;
  if (Number.isNaN(lo) || Number.isNaN(hi) || (lo !== null && hi !== null && lo >= hi)) throw new Error('The fit range needs increasing numeric limits, or can be left blank.');
  return {
    analysis_type:'histogram', histogram, fit_model:fitModel,
    formula:inputs.formula.trim(), param_names:fitModel ? splitList(inputs.param_names) : [],
    initial_guesses:fitModel ? splitList(inputs.initial_guesses).map(g => g === '' ? null : g) : [],
    title:inputs.graph_title, x_title:inputs.x_title, y_title:inputs.y_title,
    x_range:lo === null && hi === null ? null : [lo,hi],
    plot:{logx:!!options.logx, logy:!!options.logy, grid:options.grid !== false, diagnostics:fitModel ? diagnosticPayload(options) : []},
    dataset_name:datasets[activeIdx].name,
  };
}

/** The four text boxes -> the active dataset object. */
function syncActiveFromColumns() {
  const d = datasets[activeIdx];
  for (const c of COLUMNS) d[c] = $('col-' + c).value;
  // Analysis type filters datasets; it does not convert an existing dataset.
  d.histogram = readHistogramControls();
  d.fit = readDatasetFit();
}

/** The active dataset object -> the four text boxes. */
function showActiveInColumns() {
  setTimeout(() => window.AnalysisFeatures?.refresh(), 0);
  if (window.WorkspaceStore && workspaceDocument) {
    if (window.WorkspaceStore.reconcileDatasets) {
      workspaceDocument = window.WorkspaceStore.reconcileDatasets(workspaceDocument, datasets);
      datasets = workspaceDocument.inputs.datasets;
      if (!datasets.length) datasets = [newDataset('Dataset 1', '')];
      activeIdx = Math.min(activeIdx, datasets.length - 1);
    }
    window.WorkspaceStore.materialize({...workspaceDocument, inputs:{datasets}});
  }
  const d = datasets[activeIdx];
  for (const c of COLUMNS) {
    $('col-' + c).value = d[c] || '';
    $('col-' + c).readOnly = !!d.derivedFrom && (c === 'y' || c === 'ey');
    $('col-' + c).title = d.derivedFrom ? 'Calculated data. Edit its expression or sources in Analyze Data.' : '';
  }
  d.analysis_type = d.analysis_type ?? 'xy';
  $('analysis-type').value = d.analysis_type;
  const defaults = {source:'samples', bins:'', method:'poisson'};
  for (const key of HISTOGRAM_FIELDS) $('hist-' + key).value = d.histogram?.[key] ?? defaults[key] ?? '';
  writeDatasetFit(d.fit);
  syncAnalysisControls();
  if (d.analysis_type === 'multivariate' && window.Multivariate) window.Multivariate.load(d);
  updateCounts();
  showDatasetResult();
}

/** Update the "n=8" badges and flag columns that do not match X. */
function updateCounts() {
  const nx = parseColumn($('col-x').value).values.length;
  for (const c of COLUMNS) {
    const { values, bad } = parseColumn($('col-' + c).value);
    const badge = $('count-' + c);
    const shared = (c === 'ex' || c === 'ey') && values.length === 1 && !bad.length;
    badge.textContent = shared ? 'all points' : bad.length ? `${values.length} (check ${bad.length})` : String(values.length);
    badge.classList.toggle('mismatch', bad.length > 0 || (values.length > 0 && values.length !== nx && !shared));
  }
  renderDatasetSelector();
}

function renderDatasetSelector() {
  const sel = $('dataset-select');
  const current = sel.value;
  sel.innerHTML = '';
  datasets.forEach((d, i) => {
    if (!d.analysis_type || d.analysis_type !== $('analysis-type').value) return;
    const histogram = (i === activeIdx ? $('analysis-type').value : d.analysis_type) === 'histogram';
    const h = i === activeIdx ? readHistogramControls() : d.histogram || {};
    const source = h.source || 'samples';
    const n = histogram ? parseColumn(h[source === 'counts' ? 'counts' : 'samples'] || '').values.length : (i === activeIdx) ? parseColumn($('col-x').value).values.length : parseColumn(d.x).values.length;
    const unit = histogram ? (source === 'counts' ? 'bins' : 'measurements') : 'points';
    const opt = document.createElement('option');
    opt.value = String(i);
    const mv = d.analysis_type === 'multivariate';
    opt.textContent = mv ? `${d.name} - Multivariate ${window.Multivariate ? window.Multivariate.label(d) : ''}` : `${d.name} - ${histogram ? 'Histogram' : 'XY'} (${n} ${unit})`;
    sel.appendChild(opt);
  });
  sel.value = String(activeIdx);
  const fitSelect = $('fit-dataset-select');
  if (fitSelect) {
  fitSelect.innerHTML = '';
  datasets.forEach((d, i) => {
    if (!d.analysis_type || d.analysis_type !== $('analysis-type').value) return;
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = d.name + ' - ' + (d.analysis_type === 'histogram' ? 'Histogram' : d.analysis_type === 'multivariate' ? 'Multivariate' : 'XY');
    fitSelect.appendChild(option);
  });
  fitSelect.value = String(activeIdx);
  }
  const summary = $('modern-data-summary');
  if (summary) {
    const d = datasets[activeIdx];
    summary.textContent = d.analysis_type ? d.name + ' - ' + (d.analysis_type === 'histogram' ? 'Histogram' : d.analysis_type === 'multivariate' ? 'Multivariate' : 'XY') : 'Select an analysis type to get started.';
  }
  if ($('fit-dataset-label')) $('fit-dataset-label').textContent = 'These settings belong to ' + datasets[activeIdx].name + '. The expanded data table edits the same settings; choose Done there to apply changes.';
  const removeBtns = document.querySelectorAll('[data-action="dataset-remove"]');
  for (const b of removeBtns) b.disabled = !datasets[activeIdx].analysis_type;
  if (current !== sel.value) { /* nothing else to do */ }
}

// Each dataset retains its latest result; selection never reruns a fit.
function showDatasetResult() {
  const saved = datasets[activeIdx]?.result;
  if (!saved && !lastResult && !fitBusy) return;
  fitRequestVersion++;
  fitBusy = false;
  lastResult = saved?.response || null;
  lastPayload = saved ? {...saved.payload, dataset_name:datasets[activeIdx].name} : null;
  showMessage('');
  if (lastResult) {
    renderReport(lastResult);
    drawPlot(lastResult, true);
    setStatus($('fit-status'), 'Stored result - ' + datasets[activeIdx].name);
  } else {
    plotDrawVersion++;
    clearReport();
    $('plot').innerHTML = '<p class="placeholder">No result for this dataset. Run a fit to display its plot.</p>';
    lastDrawn = null;
    lastPainter = null;
    setPngEnabled(false);
    setStatus($('fit-status'), 'Ready');
  }
}

function setActiveDataset(i) {
  if (i === activeIdx) return;
  syncActiveFromColumns();
  activeIdx = Math.max(0, Math.min(datasets.length - 1, i));
  showActiveInColumns();
  autosave();
}

let addingInTable = false;
function addDataset() { openDatasetTypeChooser(false); }
function openDatasetTypeChooser(inTable) {
  addingInTable = inTable;
  $('dataset-type-dialog').showModal();
}
async function requestNewDataset(type, inTable = addingInTable) {
  if (!['xy', 'histogram', 'multivariate'].includes(type)) return;
  const name = await askDialog({title:'New dataset', label:'Dataset name', value:'', accept:'Create',
    validate: value => { if (!value.trim()) throw new Error('Enter a dataset name.'); return value.trim(); }});
  if (name === null) {
    if (!inTable) { $('analysis-type').value = datasets[activeIdx].analysis_type || ''; syncAnalysisControls(); }
    return;
  }
  addingInTable = inTable;
  createTypedDataset(type, name);
}
function createTypedDataset(type, name) {
  if (!['xy', 'histogram', 'multivariate'].includes(type)) return;
  if (addingInTable) {
    if (window.InsertData.addTableDataset(type, name) === false) return;   // keep the type chooser open if the grid does not validate
  } else {
    syncActiveFromColumns();
    if (!datasets[activeIdx].analysis_type) datasets[activeIdx] = newDataset(name || datasets[activeIdx].name, type);
    else {
      datasets.push(newDataset(name || `Dataset ${datasets.length + 1}`, type));
      activeIdx = datasets.length - 1;
    }
    showActiveInColumns();
    autosave();
  }
  $('dataset-type-dialog').close();
}
function changeAnalysisType(type) {
  if (!['xy', 'histogram', 'multivariate'].includes(type)) return;
  syncActiveFromColumns();
  let next = datasets.findIndex(d => d.analysis_type === type);
  if (next < 0) {
    if (!datasets[activeIdx].analysis_type) {
      datasets[activeIdx] = newDataset(datasets[activeIdx].name, type);
      next = activeIdx;
    } else {
      datasets.push(newDataset(`Dataset ${datasets.length + 1}`, type));
      next = datasets.length - 1;
    }
  }
  activeIdx = next;
  showActiveInColumns();
  autosave();
}

function duplicateDatasetInto(list, index) {
  const original = list[index];
  const base = original.name + ' (copy)';
  let name = base, suffix = 2;
  while (list.some(d => d.name === name)) name = original.name + ' (copy ' + suffix++ + ')';
  const copy = JSON.parse(JSON.stringify(original));
  if (window.WorkspaceStore) copy.id = window.WorkspaceStore.id();
  delete copy.derivedFrom;
  if (copy.result) delete copy.result.objectId;
  copy.name = name;
  list.splice(index + 1, 0, copy);
  return index + 1;
}
function duplicateDataset() {
  syncActiveFromColumns();
  activeIdx = duplicateDatasetInto(datasets, activeIdx);
  showActiveInColumns();
  autosave();
}

async function renameDataset() {
  const d = datasets[activeIdx];
  const name = await requestDatasetName(d.name);
  if (name === null) return;
  d.name = name.trim() || d.name;
  renderDatasetSelector();
  autosave();
}

async function removeDataset() {
  if (!datasets[activeIdx].analysis_type) return;
  syncActiveFromColumns();
  const d = datasets[activeIdx];
  const histogram = d.analysis_type === 'histogram';
  const n = parseColumn(histogram ? (d.histogram?.[d.histogram.source === 'counts' ? 'counts' : 'samples'] || '') : d.x).values.length;
  if (n > 0 && !await confirmDatasetDeletion(d.name, n, histogram ? 'histogram entries' : 'points')) return;
  datasets.splice(activeIdx, 1);
  if (!datasets.length) datasets = [newDataset('Dataset 1', '')];
  const sameType = datasets.findIndex(item => item.analysis_type === d.analysis_type);
  activeIdx = sameType >= 0 ? sameType : Math.min(activeIdx, datasets.length - 1);
  resetResult();
  showActiveInColumns();
  autosave();
}

// ================================================================ 4. data table

// The "Insert data" table editor lives in insert-data.js (window.InsertData) so
// the plotting tool and Analyze Data share one data-entry system. This page
// drives it through a host adapter that reads and writes the plotting datasets.
const plotInsertHost = {
  fitSettings: true,
  addLabel: 'New plot',
  types: ['xy', 'histogram', 'multivariate'],
  datasets: () => datasets,
  activeIndex: () => activeIdx,
  color: (i) => datasetColor(i),
  newDataset: (name, type) => newDataset(name, type),
  requestName: (current) => requestDatasetName(current),
  newName: (suggested) => askDialog({ title: 'New dataset', label: 'Dataset name', value: suggested, accept: 'Create',
    validate: (value) => { if (!value.trim()) throw new Error('Enter a dataset name.'); return value.trim(); } }),
  confirmDelete: (name, n, unit) => confirmDatasetDeletion(name, n, unit),
  message: (kind, text) => showMessage(kind, text),
  afterClose: () => showActiveInColumns(),
  commit: ({ datasets: edited, activeIndex, deleted }) => {
    if (deleted) resetResult();
    datasets = edited;
    activeIdx = activeIndex;
    showActiveInColumns();
    autosave();
  },
};

function openTable() {
  if (datasets[activeIdx]?.derivedFrom) { showMessage('info', 'This dataset is calculated. Edit its expression or sources in Analyze Data.'); return; }
  syncActiveFromColumns();
  window.InsertData.open(plotInsertHost);
}

// ================================================================ 5. form <-> object

/** Split "a, b, c" into ["a","b","c"], keeping empty slots ("1,,3"). */
function splitList(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  return s.split(',').map((t) => t.trim());
}

function numberOrNull(text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

const DIAGNOSTIC_TYPES = ['residual', 'pull', 'ratio', 'percent', 'histogram'];
const DIAGNOSTIC_NAMES = { residual: 'Residuals', pull: 'Pulls', ratio: 'Data / fit', percent: 'Percentage difference', histogram: 'Residual histogram' };
const DIAGNOSTIC_FIELDS = ['title', 'x_title', 'y_title', 'y_min', 'y_max', 'height', 'bins', 'scope', 'grid', 'reference', 'errors'];

function selectedDiagnostics(options) {
  if (Array.isArray(options.diagnostics)) return DIAGNOSTIC_TYPES.filter(k => options.diagnostics.includes(k));
  return ['residual', 'pull'].includes(options.residuals) ? [options.residuals] : [];
}

function readDiagnosticSettings() {
  return Object.fromEntries(DIAGNOSTIC_TYPES.map(kind => [kind, Object.fromEntries(DIAGNOSTIC_FIELDS.map(key => {
    const el = $('diag-' + kind + '-' + key);
    return [key, el ? el.type === 'checkbox' ? el.checked : el.value.trim() : undefined];
  }))]));
}

function syncDiagnosticControls() {
  let any = false;
  for (const kind of DIAGNOSTIC_TYPES) {
    const selected = $('diag-' + kind).checked;
    $('diag-settings-' + kind).hidden = !selected;
    any ||= selected;
  }
  $('diag-empty').hidden = any;
}

function writeDiagnosticSettings(options) {
  const selected = selectedDiagnostics(options);
  for (const kind of DIAGNOSTIC_TYPES) {
    $('diag-' + kind).checked = selected.includes(kind);
    const settings = (options.diagnostic_settings || {})[kind] || {};
    for (const key of DIAGNOSTIC_FIELDS) {
      const el = $('diag-' + kind + '-' + key);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = settings[key] !== false;
      else el.value = String(settings[key] ?? ({ height: 240, bins: 15, scope: 'fit' }[key] ?? ''));
    }
  }
  syncDiagnosticControls();
}

function diagnosticPayload(options) {
  return selectedDiagnostics(options).map(kind => {
    const cfg = { ...((options.diagnostic_settings || {})[kind] || {}), kind };
    const name = DIAGNOSTIC_NAMES[kind];
    for (const key of ['y_min', 'y_max']) {
      cfg[key] = numberOrNull(cfg[key]);
      if (Number.isNaN(cfg[key])) throw new Error(`${name}: enter a number for the Y limits, or leave them blank for automatic limits.`);
    }
    if (cfg.y_min !== null && cfg.y_max !== null && cfg.y_min >= cfg.y_max) throw new Error(`${name}: the lower Y limit needs to be smaller than the upper limit.`);
    for (const [key, fallback, low, high] of [['height', 240, 180, 480], ['bins', 15, 5, 100]]) {
      cfg[key] = cfg[key] === undefined || cfg[key] === '' ? fallback : Number(cfg[key]);
      if (!Number.isInteger(cfg[key]) || cfg[key] < low || cfg[key] > high) throw new Error(`${name}: ${key} needs a whole number from ${low} to ${high}.`);
    }
    return cfg;
  });
}

/** Everything the user typed, as one plain object (what gets saved). */
function readForm() {
  syncActiveFromColumns();
  const active = datasets[activeIdx];
  return {
    datasets: datasets.map((d) => ({ ...d })),
    active: activeIdx,
    analysis_type: active.analysis_type ?? 'xy',
    histogram: active.histogram,
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
      diagnostics: DIAGNOSTIC_TYPES.filter(kind => $('diag-' + kind).checked),
      diagnostic_settings: readDiagnosticSettings(),
    },
  };
}

function writeForm(inputs) {
  inputs = inputs || {};
  const legacyFit = normalizeFitSettings({formula:inputs.formula ?? '', param_names:inputs.param_names ?? '', initial_guesses:inputs.initial_guesses ?? '', x_min:inputs.options?.x_min ?? '', x_max:inputs.options?.x_max ?? ''});
  if (Array.isArray(inputs.datasets) && inputs.datasets.length) {
    datasets = inputs.datasets.map((d, i) => ({
      ...d,
      id: d?.id || window.WorkspaceStore?.id(),
      name: String((d && d.name) || `Dataset ${i + 1}`),
      analysis_type: d?.analysis_type === '' ? '' : ['histogram','multivariate'].includes(d?.analysis_type) ? d.analysis_type : 'xy',
      result: d?.result?.response && Array.isArray(d.result.response.params) ? d.result : null,
      histogram: d?.histogram && typeof d.histogram === 'object' ? {...d.histogram} : {},
      fit: normalizeFitSettings(d?.fit && typeof d.fit === 'object' ? d.fit : legacyFit),
      x: String((d && d.x) || ''), y: String((d && d.y) || ''), ex: String((d && d.ex) || ''), ey: String((d && d.ey) || ''),
    }));
    activeIdx = Math.max(0, Math.min(datasets.length - 1, parseInt(inputs.active, 10) || 0));
  } else {
    const d = inputs.data || {};
    datasets = [{ id:window.WorkspaceStore?.id(), name: 'Dataset 1', fit:{...legacyFit}, x: String(d.x || ''), y: String(d.y || ''), ex: String(d.ex || ''), ey: String(d.ey || '') }];
    activeIdx = 0;
  }
  showActiveInColumns();
  $('graph-title').value = inputs.graph_title || '';
  $('x-title').value = inputs.x_title || '';
  $('y-title').value = inputs.y_title || '';
  const o = inputs.options || {};
  $('opt-logx').checked = !!o.logx;
  $('opt-logy').checked = !!o.logy;
  $('opt-grid').checked = o.grid === undefined ? true : !!o.grid;
  writeDiagnosticSettings(o);
  renderParamTable();
}

async function clearAll() {
  const confirmed = await askDialog({title:'Clear all',
    message:'Clear all datasets, fit settings, plots, results, and analysis notes? Saved files will not be deleted.',
    accept:'Clear all', destructive:true});
  if (!confirmed) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  clearForm();
  documentCreated = null;
  clearAutosave();
  markAnalysisSaved();
}

function clearForm() {
  if (window.WorkspaceStore) workspaceDocument = {...window.WorkspaceStore.empty(), revision:workspaceDocument?.revision || null};
  writeForm({ datasets: [newDataset('Dataset 1', '')], formula: '[0]*x+[1]' });
  $('doc-title').value = '';
  $('doc-notes').value = '';
  resetResult();
}

function resetResult() {
  fitRequestVersion++;
  plotDrawVersion++;
  fitBusy = false;
  clearReport();
  $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
  setPngEnabled(false);
  lastResult = null;
  lastPayload = null;
  lastDrawn = null;
  showMessage('');
  setStatus($('fit-status'), 'Ready');
  document.dispatchEvent(new CustomEvent('rootfit:reset'));
}

/** Buttons that only make sense once there is a plot / a result. */
function setPngEnabled(on) {
  $('btn-png').disabled = !on;
  for (const el of document.querySelectorAll('[data-needs-plot]')) el.disabled = !on;
}
function setResultEnabled(on) {
  for (const el of document.querySelectorAll('[data-needs-result]')) el.disabled = !on;
  $('report-tools').hidden = !on;
  window.AnalysisFeatures?.renderResult(on ? lastResult : null);
  const d = datasets[activeIdx];
  const hasData = d?.analysis_type === 'histogram'
    ? parseColumn(d.histogram?.[d.histogram.source === 'counts' ? 'counts' : 'samples'] || '').values.length > 0
    : !!(d && parseColumn(d.x || '').values.length && parseColumn(d.y || '').values.length);
  for (const el of document.querySelectorAll('[data-classic-analysis]')) {
    el.hidden = !(on && hasData && lastResult?.params?.length);
  }
}

/** Turn the form into the JSON body the backend expects. Throws an Error with
 *  a human-readable message if the data cannot be used. */
function buildPayload(inputs, fitModel = true) {
  if (inputs.analysis_type === '') throw new Error('Select an analysis type in Data to get started.');
  if (inputs.analysis_type === 'histogram') {
    const payload = buildHistogramPayload(inputs, fitModel);
    payload.plot.confidence_level = datasets[activeIdx].confidenceLevel || null;
    return payload;
  }
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
  if (cols.x.length !== cols.y.length) throw new Error(`X has ${cols.x.length} points but Y has ${cols.y.length}. Each point needs an X and a Y value. Add the missing values or remove the extra ones.`);
  for (const c of ['ex', 'ey']) {
    if (cols[c].some((v) => v < 0)) throw new Error(`${COLUMN_LABEL[c]} describe a size, so use zero or a positive number.`);
    if (cols[c].length === 1) cols[c] = Array(cols.x.length).fill(cols[c][0]);
    else if (cols[c].length && cols[c].length !== cols.x.length) {
      throw new Error(`${COLUMN_LABEL[c]}: ${cols[c].length} values for ${cols.x.length} points. Enter one value for the whole axis, ${cols.x.length} values for individual points, or leave it blank.`);
    }
  }
  const excluded = (datasets[activeIdx].exclusions || []).filter(p => cols.x[p.index] === p.x && cols.y[p.index] === p.y);
  if (excluded.length !== (datasets[activeIdx].exclusions || []).length) throw new Error('Some excluded measurements have changed position or value. Review Point exclusions and apply them again before fitting.');
  const omit = new Set(excluded.map(p => p.index));
  for (const c of COLUMNS) cols[c] = cols[c].filter((_, i) => !omit.has(i));
  if (cols.x.length < 2) throw new Error('Include at least two measurements before plotting. Review Point exclusions.');
  // No fit function is allowed: the backend then just plots the data points.

  const o = inputs.options || {};
  const xmin = numberOrNull(o.x_min);
  const xmax = numberOrNull(o.x_max);
  if (Number.isNaN(xmin) || Number.isNaN(xmax)) throw new Error('Each fit-range limit must be a number or blank.');
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
    plot: { confidence_level:datasets[activeIdx].confidenceLevel || null, excluded_points:excluded, logx: !!o.logx, logy: !!o.logy, grid: o.grid !== false, diagnostics: diagnosticPayload(o), residuals: o.residuals || 'none' },
    dataset_name: name,
  };
}

/** A log-linear estimate supplies a useful start for the decay example. */
function decayStartingGuesses(inputs) {
  const x = parseColumn(inputs.data.x), y = parseColumn(inputs.data.y);
  if (x.bad.length || y.bad.length || x.values.length !== y.values.length) return '';
  const o = inputs.options || {};
  const lo = numberOrNull(o.x_min), hi = numberOrNull(o.x_max);
  const points = x.values.map((v, i) => [v, y.values[i]])
    .filter(([v, w]) => w > 0 && (lo === null || v >= lo) && (hi === null || v <= hi));
  if (points.length < 2) return '';
  const mx = points.reduce((s, [v]) => s + v, 0) / points.length;
  const my = points.reduce((s, [, w]) => s + Math.log(w), 0) / points.length;
  const variance = points.reduce((s, [v]) => s + (v - mx) ** 2, 0);
  const slope = points.reduce((s, [v, w]) => s + (v - mx) * (Math.log(w) - my), 0) / variance;
  const amplitude = Math.exp(my - slope * mx), tau = -1 / slope;
  return slope < 0 && amplitude > 0 && Number.isFinite(amplitude) && Number.isFinite(tau)
    ? `${Number(amplitude.toPrecision(4))}, ${Number(tau.toPrecision(4))}` : '';
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
  const n = window.RootEquationEditor?.parameterCount?.() ?? countParams($('formula').value);
  const names = splitList($('param-names').value);
  const guesses = splitList($('initial-guesses').value);
  const tbody = $('param-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="idx">[${i}]</td>` +
      `<td><input type="text" aria-label="Parameter ${i} name" data-pname="${i}" value="${escapeHtml(names[i] || '')}" placeholder="p${i}" spellcheck="false"></td>` +
      `<td><input type="text" class="mono" inputmode="decimal" aria-label="Parameter ${i} initial guess" data-pguess="${i}" value="${escapeHtml(guesses[i] || '')}" placeholder="Default"></td>`;
    tbody.appendChild(tr);
  }
  const note = $('param-table-note');
  if (n === 0) note.textContent = 'No parameters found in the formula.';
  else {
    const extra = Math.max(names.length, guesses.length) - n;
    note.textContent = `${n} parameter${n === 1 ? '' : 's'} in the formula.` + (extra > 0 ? ` (${extra} extra value${extra === 1 ? '' : 's'} in the lists are ignored.)` : '');
  }
  window.RootEquationEditor?.sync();
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
  syncDatasetFit();
  autosave();
}

// ================================================================ 7. backend

function backendUrl() {
  const saved = (storageGet(BACKEND_KEY) || '').trim();
  if (saved) return saved.replace(/\/+$/, '');
  return (resolvedBackend || DEFAULT_BACKEND).replace(/\/+$/, '');
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
    setStatus($('health-status'), 'Backend: disconnected', 'err');
    if (e.name === 'AbortError') throw new Error('The backend did not respond in time. Your input is still here; please try again.');
    throw new Error('The backend is unavailable. Your input is still here; please try again shortly.');
  }
  clearTimeout(timer);
  setStatus($('health-status'), 'Backend: connected', 'ok');

  let body = null;
  const text = await response.text();
  try { body = JSON.parse(text); } catch (_) { /* not JSON */ }

  if (!response.ok) {
    const msg = body && body.error ? body.error : 'The fitting service could not finish this request. Your inputs are still here; please try Fit again.';
    throw new Error(msg);
  }
  if (body === null) throw new Error('The fitting service sent a response the app could not read. Your inputs are still here. Please try Fit again; if this continues, contact the site maintainer.');
  return body;
}

async function checkHealth() {
  const el = $('health-status');
  setStatus(el, 'Backend: checking', 'busy');
  try {
    await resolveBackend();
    await callBackend('/health', {}, 8000);
    setStatus(el, 'Backend: connected', 'ok');
  } catch (e) {
    setStatus(el, 'Backend: disconnected', 'err');
  }
}

let fitRequestVersion = 0;
let fitBusy = false;
let lastResult = null;    // the last successful /fit response (used by save & export)
let lastPayload = null;   // what was sent for it

async function runFit(fitModel = true) {
  fitModel = fitModel !== false;
  if ($('btn-fit').disabled || fitBusy) return;
  if (datasets[activeIdx]?.analysis_type === 'multivariate') return runMultivariate();
  showMessage('');
  hideHelp();
  let payload;
  try {
    if (fitModel) window.RootEquationEditor?.validate();
    if (datasets[activeIdx]?.calculationError) throw new Error(datasets[activeIdx].calculationError);
    payload = buildPayload(readForm(), fitModel);
    payload.plot.confidence_level = datasets[activeIdx].confidenceLevel || null;
  } catch (e) {
    showMessage('error', e.message);
    return;
  }

  const requestVersion = ++fitRequestVersion;
  fitBusy = true;
  const btn = $('btn-fit');
  btn.disabled = true;
  $('btn-histogram').disabled = true;
  setStatus($('fit-status'), fitModel ? 'Fitting' : 'Plotting histogram', 'busy');
  try {
    const result = await callBackend(payload.analysis_type === 'histogram' ? '/histogram' : '/fit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (requestVersion !== fitRequestVersion) return;
    datasets[activeIdx].result = {response:result, payload, sourceSignature:window.WorkspaceStore?.signature(datasets[activeIdx])};
    lastResult = result;
    lastPayload = payload;
    renderReport(result);
    await drawPlot(result);
    if (requestVersion !== fitRequestVersion) return;
    autosave();
    const plotNote = result.analysis_type === 'histogram'
      ? ((result.histogram.underflow || result.histogram.overflow) ? result.plot_notes[0] : '')
      : result.plot_notes?.length ? result.plot_notes.join('\n') : (result.residuals?.note || '');
    if (!result.converged) {
      showMessage('warn', `Fit did not converge. ${result.status_message} Check initial guesses, parameter identifiability, and the fit range before interpreting the result.` + (plotNote ? '\n' + plotNote : ''));
    } else {
      const gof = goodnessOfFitNote(result);
      if (gof) showMessage('warn', gof + (plotNote ? '\n' + plotNote : ''));
      else if (plotNote) showMessage('info', plotNote);
    }
    setStatus($('fit-status'), result.converged ? `${result.fit_performed === false ? 'Plotted' : 'Fit done'} - ${payload.dataset_name}` : 'Fit not converged', result.converged ? 'ok' : 'warn');
  } catch (e) {
    if (requestVersion !== fitRequestVersion) return;
    showMessage('error', e.message + (lastResult ? ' The plot and report below are from the previous fit.' : ''));
    setStatus($('fit-status'), 'Fit not completed', 'err');
  } finally {
    if (requestVersion === fitRequestVersion) {
      fitBusy = false;
      syncAnalysisControls();
      $('btn-histogram').disabled = false;
    }
  }
}

async function runMultivariate() {
  if ($('btn-fit').disabled || fitBusy) return;
  showMessage('');
  hideHelp();
  let payload;
  try {
    payload = window.Multivariate.buildPayload(datasets[activeIdx]);
  } catch (e) {
    showMessage('error', e.message);
    return;
  }
  const requestVersion = ++fitRequestVersion;
  fitBusy = true;
  $('btn-fit').disabled = true;
  $('btn-histogram').disabled = true;
  setStatus($('fit-status'), 'Fitting', 'busy');
  try {
    const result = await callBackend('/multivariate-fit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (requestVersion !== fitRequestVersion) return;
    datasets[activeIdx].result = { response: result, payload, sourceSignature: window.WorkspaceStore?.signature(datasets[activeIdx]) };
    lastResult = result;
    lastPayload = payload;
    renderReport(result);
    await drawPlot(result);
    if (requestVersion !== fitRequestVersion) return;
    autosave();
    const notes = (result.plot_notes || []).join('\n');
    if (!result.converged) {
      showMessage('warn', `Fit did not converge. ${result.status_message} Check the models, starting guesses, and that the data constrain every parameter.` + (notes ? '\n' + notes : ''));
    } else {
      const gof = goodnessOfFitNote(result);
      if (gof) showMessage('warn', gof + (notes ? '\n' + notes : ''));
      else if (notes) showMessage('info', notes);
    }
    setStatus($('fit-status'), result.converged ? `Fit done - ${payload.dataset_name}` : 'Fit not converged', result.converged ? 'ok' : 'warn');
  } catch (e) {
    if (requestVersion !== fitRequestVersion) return;
    showMessage('error', e.message + (lastResult ? ' The plot and report below are from the previous fit.' : ''));
    setStatus($('fit-status'), 'Fit not completed', 'err');
  } finally {
    if (requestVersion === fitRequestVersion) {
      fitBusy = false;
      syncAnalysisControls();
      $('btn-histogram').disabled = false;
    }
  }
}

// ================================================================ 8. fit report

function chi2Class(r) {
  // Reduced chi-square alone cannot classify a fit as good or bad.
  return '';
}

/** A short, scientific note on the goodness of fit, or '' when there is nothing
 *  to flag. Reduced χ² is read against its degrees of freedom through the
 *  p-value; both an implausibly high and an implausibly low value are noted. The
 *  test is only meaningful when the fit was weighted by real uncertainties. */
function goodnessOfFitNote(r) {
  if (!r || r.converged === false || r.chi2_ndf == null) return '';
  let weighted;
  if (r.analysis_type === 'histogram') weighted = r.method === 'chi2';           // √count errors
  else if (r.analysis_type === 'multivariate') weighted = (lastPayload?.output_errors || []).some(c => c && c.length);
  else weighted = !!((lastPayload?.ey && lastPayload.ey.length) || (lastPayload?.ex && lastPayload.ex.length));
  if (!weighted) return '';
  const c = r.chi2_ndf;
  const p = typeof r.prob === 'number' ? r.prob : null;
  const stat = `χ²/NDF = ${fmtNum(c, 3)}` + (p == null ? '' : ` (p = ${fmtNum(p, 3)})`);
  if ((p != null && p < 0.01) || c > 3)
    return `${stat}: the data depart from the model by more than the stated uncertainties.`;
  if ((p != null && p > 0.99) || c < 0.3)
    return `${stat}: residuals lie well within the stated uncertainties, which may be overestimated.`;
  return '';
}

function renderHistogramReport(r) {
  const h = r.histogram;
  const rows = r.params.map(p => `<tr><td>${escapeHtml(p.name)}</td><td class="num">${fmtPair(p.value,p.error)}</td><td class="num">${fmtNum(p.value,8)}</td><td class="num">${fmtNum(p.error,4)}</td></tr>`).join('');
  const fitted = r.fit_performed !== false;
  $('report').innerHTML = `<p>${escapeHtml(lastPayload?.dataset_name || 'Histogram')}: ${h.counts.length} bins, ${h.total} counts inside the edges. ${escapeHtml(r.status_message)}</p>
    <p class="fine">Outside the edges: ${h.underflow} below, ${h.overflow} above. Display: counts per unit X.</p>
    ${fitted ? `<p>Function <code>${escapeHtml(r.formula)}</code>; ${r.method === 'poisson' ? 'Poisson likelihood' : 'χ² with √count uncertainties'}; fit range [${fmtNum(r.range[0])}, ${fmtNum(r.range[1])}], ${r.n_points} usable bins.</p>
    <table class="report-table"><thead><tr><th>Parameter</th><th>Value ± uncertainty</th><th>Value (8 s.f.)</th><th>Uncertainty (4 s.f.)</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="summary"><div class="stat"><span class="k">${escapeHtml(r.statistic_name)}</span><span class="v">${fmtNum(r.statistic)}</span></div><div class="stat"><span class="k">NDF</span><span class="v">${r.ndf}</span></div>${r.method === 'chi2' ? `<div class="stat"><span class="k">χ² / NDF</span><span class="v">${fmtNum(r.chi2_ndf)}</span></div><div class="stat"><span class="k">p-value</span><span class="v">${fmtNum(r.prob)}</span></div>` : ''}</div>` : '<p>No model fitted. Choose a function in Fit settings to fit these bins.</p>'}
    ${residualSummary(r)}<p class="fine">${(r.plot_notes || []).map(escapeHtml).join('<br>')}</p>`;
  setResultEnabled(true);
}

function renderReport(r) {
  if (r.analysis_type === 'histogram') { renderHistogramReport(r); return; }
  if (r.analysis_type === 'multivariate') { window.Multivariate.renderReport(r, lastPayload); setResultEnabled(true); return; }
  if (r.fit_performed === false) {
    const ds = lastPayload && lastPayload.dataset_name ? `<span class="ds-name">${escapeHtml(lastPayload.dataset_name)}</span>: ` : '';
    $('report').innerHTML = `<p>${ds}${r.n_points} points plotted. No fit function given. Enter one in Fit settings to fit these data.</p>`;
    setResultEnabled(true);
    return;
  }
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
      <thead><tr><th>Parameter</th><th>Value ± uncertainty</th><th>Value (8 s.f.)</th><th>Uncertainty (4 s.f.)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="summary">
      <div class="stat"><span class="k">χ²</span><span class="v">${fmtNum(r.chi2)}</span></div>
      <div class="stat"><span class="k">NDF</span><span class="v">${r.ndf}</span></div>
      <div class="stat ${chi2Class(r)}"><span class="k">χ² / NDF</span><span class="v">${r.chi2_ndf === null ? ' - ' : fmtNum(r.chi2_ndf, 4)}</span></div>
      <div class="stat"><span class="k">p-value</span><span class="v">${fmtNum(r.prob, 4)}</span></div>
    </div>`;
  setResultEnabled(true);
}

/** One line about the residuals: RMS, and the worst pull if errors exist. */
function residualSummary(r) {
  if (Array.isArray(r.diagnostics)) return r.diagnostics.length ? `<p class="fine">Optional plots: ${r.diagnostics.map(p => `${escapeHtml(p.title)} (${p.n_points} points)`).join('; ')}.</p>` : '';
  const R = r.residuals;
  if (!R || R.kind === 'none' || !Array.isArray(R.values) || !R.values.length) return '';
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
  L.push(`ROOT-A-TRON 3000 report - ${$('doc-title').value || 'untitled'}`);
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
  if (r.analysis_type === 'histogram') {
    L.push(`Histogram counts: ${r.histogram.total}; bins: ${r.histogram.counts.length}; underflow: ${r.histogram.underflow}; overflow: ${r.histogram.overflow}`);
    L.push(`Fit performed: ${r.fit_performed}; method: ${r.method}`);
    if (r.fit_performed) L.push(`${r.statistic_name} = ${r.statistic}`);
    L.push(...r.plot_notes);
  }
  if (r.fit_performed !== false) L.push(`NDF      = ${r.ndf}`);
  if (r.analysis_type !== 'histogram' || (r.fit_performed && r.method === 'chi2')) {
    L.push(`chi2     = ${r.chi2}`);
    L.push(`chi2/NDF = ${r.chi2_ndf}`);
    L.push(`p-value  = ${r.prob}`);
  }
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
  if (r.analysis_type === 'histogram') {
    L.push(`analysis_type,histogram`, `fit_performed,${r.fit_performed}`, `method,${r.method}`, `statistic_name,${q(r.statistic_name)}`, `statistic,${r.statistic}`, `total_counts,${r.histogram.total}`, `underflow,${r.histogram.underflow}`, `overflow,${r.histogram.overflow}`);
    for (const note of r.plot_notes) L.push(`note,${q(note)}`);
  }
  if (r.fit_performed !== false) L.push(`ndf,${r.ndf}`);
  if (r.analysis_type !== 'histogram' || (r.fit_performed && r.method === 'chi2')) {
    L.push(`chi2,${r.chi2}`);
    L.push(`chi2_ndf,${r.chi2_ndf}`);
    L.push(`prob,${r.prob}`);
  }
  L.push(`status,${q(r.status_message)}`);
  L.push(`formula,${q(r.formula)}`);
  L.push(`x_min,${r.range[0]}`);
  L.push(`x_max,${r.range[1]}`);
  if (r.analysis_type === 'histogram') {
    L.push('', 'bin_lower,bin_upper,count,count_density,expected_count');
    const h = r.histogram;
    h.counts.forEach((count,i) => L.push(`${h.edges[i]},${h.edges[i+1]},${count},${count/(h.edges[i+1]-h.edges[i])},${h.expected[i] ?? ''}`));
  }
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
      throw new Error(`Could not load JSROOT from root.cern - are you online? (${e.message})`);
    });
  }
  return jsrootPromise;
}

/** Apply the current appearance settings to a plot object (a deep copy; the
 *  original is left untouched). No-op if plot-style.js is unavailable. */
function styleJson(json) {
  if (window.PlotStyle && plotStyle) {
    try { return window.PlotStyle.styledCanvas(json, plotStyle); } catch (_) { /* draw as-is */ }
  }
  return json;
}

function drawableFrom(result) {
  if (result && result.canvas_json) return { json: styleJson(result.canvas_json), option: '' };
  if (result && result.graph_json) return { json: styleJson(result.graph_json), option: 'AP' };
  return null;
}

let plotDrawVersion = 0;
async function drawPlot(result, selection = false, restyle = false) {
  const drawVersion = ++plotDrawVersion;
  if (!selection && !restyle) document.dispatchEvent(new CustomEvent('rootfit:draw'));
  const plot = $('plot');
  applyPlotHeight(result);
  // On a fresh draw (not a live restyle), let the Plot-options controls reflect
  // the axis/grid state the backend actually drew.
  if (!restyle && result && result.canvas_json && window.PlotStyle && plotStyle) {
    const ax = window.PlotStyle.readAxes(result.canvas_json);
    if (ax) { Object.assign(plotStyle, ax); refreshPlotOptionsUI(); }
  }
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
    if (drawVersion !== plotDrawVersion) return;
  } catch (e) {
    if (drawVersion !== plotDrawVersion) return;
    plot.innerHTML = `<p class="placeholder">${escapeHtml(e.message)}<br>The fit report below is still valid.</p>`;
    return;
  }
  try {
    const surface = document.createElement('div');
    surface.style.width = '100%';
    surface.style.height = '100%';
    surface.dataset.plotSurface = 'true';
    // JSROOT measures its container during drawing. It must be attached first.
    jsroot.cleanup(plot);
    plot.replaceChildren(surface);
    const obj = jsroot.parse(JSON.stringify(src.json));      // parse() edits its input: give it a copy
    const painter = await jsroot.draw(surface, obj, src.option);
    if (drawVersion !== plotDrawVersion) { jsroot.cleanup(surface); return; }
    jsroot.registerForResize(painter);
    lastDrawn = src;
    lastPainter = painter;
    setPngEnabled(true);
    setStatus($('jsroot-status'), `JSROOT ${jsroot.version}`);
  } catch (e) {
    if (drawVersion !== plotDrawVersion) return;
    plot.innerHTML = `<p class="placeholder">JSROOT could not draw the result: ${escapeHtml(e.message)}</p>`;
  }
}

/** Tell JSROOT the plot box changed size (after dragging the handle). */
function replotToSize() {
  if (window.JSROOT && lastDrawn) {
    try { window.JSROOT.resize($('plot').querySelector('[data-plot-surface]') || $('plot'), true); } catch (_) { /* ignore */ }
  }
}

// --- full-screen mode: the Expand button blows the plot up to fill the window ---
let plotExpanded = false;

// The plot's appearance settings (axes, grid, boxes, marker/line looks). Loaded
// from plot-style.js at init; applied client-side, never sent to the backend.
let plotStyle = null;

/** Enter or leave full-screen. The plot's frame becomes a fixed overlay that
 *  covers the whole window (see .plot-fullscreen in the CSS); JSROOT then
 *  redraws to fill it. */
function setPlotFullscreen(on) {
  plotExpanded = !!on;
  const plot = $('plot');
  const frame = plot && plot.closest ? plot.closest('.canvas-frame') : null;
  if (frame) frame.classList.toggle('plot-fullscreen', plotExpanded);
  try { document.body.style.overflow = plotExpanded ? 'hidden' : ''; } catch (_) { /* ignore */ }
  syncExpandButton();
  applyPlotHeight();
  replotToSize();
}

function toggleExpandPlot() { setPlotFullscreen(!plotExpanded); }

/** Set the plot height. In full-screen the CSS overlay owns the size, so the
 *  inline height is cleared; otherwise use a backend height, then a manually
 *  dragged height, then the CSS default. */
function applyPlotHeight(result = lastResult) {
  const plot = $('plot');
  if (!plot) return;
  if (plotExpanded) { plot.style.height = ''; return; }
  let h = null;
  if (result && result.plot_height) h = result.plot_height;
  else h = loadLayout().plotH || null;
  plot.style.height = h ? h + 'px' : '';
}

/** Reflect the current state on the toggle button. */
function syncExpandButton() {
  const btn = $('plot-expand');
  if (!btn) return;
  btn.setAttribute('aria-pressed', plotExpanded ? 'true' : 'false');
  btn.textContent = plotExpanded ? 'Collapse plot' : 'Expand plot';
  btn.title = plotExpanded
    ? 'Return the plot to its normal size'
    : 'Blow the plot up to fill the whole window';
}

// ---- advanced plot options (client-side appearance) --------------------------

/** Redraw the current plot with the latest appearance settings, and remember
 *  them for next time. Restyle draws skip the axis re-sync and the draw event. */
function changePlotStyle() {
  if (window.PlotStyle && plotStyle) window.PlotStyle.save(plotStyle);
  if (lastResult && (lastResult.canvas_json || lastResult.graph_json)) drawPlot(lastResult, false, true);
}

/** Set every control in the Plot-options panel from the current plotStyle. */
function refreshPlotOptionsUI() {
  const pop = $('plot-options-pop');
  if (!pop || !plotStyle) return;
  for (const el of pop.querySelectorAll('[data-po]')) {
    const key = el.dataset.po;
    if (el.type === 'checkbox') el.checked = !!plotStyle[key];
    else el.value = String(plotStyle[key]);
  }
}

/** Build the popover once and hang it inside the canvas frame (a sibling of the
 *  plot, so it survives JSROOT redraws). */
function buildPlotOptionsPanel() {
  const btn = $('plot-options-btn');
  if (!btn || $('plot-options-pop') || !window.PlotStyle) return;
  const P = window.PlotStyle;
  const opts = (list) => list.map((o) => `<option value="${o.v}">${o.name}</option>`).join('');
  const check = (key, label) => `<label class="po-check"><input type="checkbox" data-po="${key}"> ${label}</label>`;
  const select = (key, label, list) => `<label class="po-field"><span>${label}</span><select data-po="${key}">${opts(list)}</select></label>`;
  const pop = document.createElement('div');
  pop.id = 'plot-options-pop';
  pop.className = 'plot-options-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Plot options');
  pop.hidden = true;
  pop.innerHTML = `
    <div class="po-head"><strong>Plot options</strong><button type="button" class="po-reset">Reset</button></div>
    <fieldset class="po-group"><legend>Axes</legend>
      ${check('logx', 'Log X')}${check('logy', 'Log Y')}${check('gridx', 'Grid X')}${check('gridy', 'Grid Y')}
    </fieldset>
    <fieldset class="po-group"><legend>Show</legend>
      ${check('stats', 'Stats box')}${check('legend', 'Legend')}${check('title', 'Title')}
    </fieldset>
    <fieldset class="po-group"><legend>Data points</legend>
      ${select('markerColor', 'Color', P.COLORS)}${select('markerStyle', 'Shape', P.MARKERS)}${select('markerSize', 'Size', P.MARKER_SIZES)}
    </fieldset>
    <fieldset class="po-group"><legend>Fit line</legend>
      ${select('lineColor', 'Color', P.COLORS)}${select('lineWidth', 'Width', P.LINE_WIDTHS)}${select('lineStyle', 'Style', P.LINE_STYLES)}
    </fieldset>`;
  (btn.closest('.canvas-frame') || btn.parentElement).appendChild(pop);

  pop.addEventListener('click', (ev) => ev.stopPropagation());
  pop.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-po]');
    if (!el) return;
    const key = el.dataset.po;
    plotStyle[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
    changePlotStyle();
  });
  pop.querySelector('.po-reset').addEventListener('click', () => {
    plotStyle = { ...window.PlotStyle.DEFAULTS };
    refreshPlotOptionsUI();
    changePlotStyle();
  });
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); togglePlotOptions(); });
  document.addEventListener('click', closePlotOptions);
  refreshPlotOptionsUI();
}

function togglePlotOptions() {
  const pop = $('plot-options-pop');
  const btn = $('plot-options-btn');
  if (!pop) return;
  const open = pop.hidden;
  pop.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) refreshPlotOptionsUI();
}

function closePlotOptions() {
  const pop = $('plot-options-pop');
  if (pop && !pop.hidden) { pop.hidden = true; const b = $('plot-options-btn'); if (b) b.setAttribute('aria-expanded', 'false'); }
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
  const main = $('main');
  if (main) main.style.removeProperty('--left-w');
  const plot = $('plot');
  const frame = plot && plot.closest ? plot.closest('.canvas-frame') : null;
  plotExpanded = false;
  if (frame) frame.classList.remove('plot-fullscreen');
  try { document.body.style.overflow = ''; } catch (_) { /* ignore */ }
  syncExpandButton();
  if (plot) plot.style.height = '';
  replotToSize();
}

function initResizers() {
  applyLayout();

  // Column splitter (Compact only): drag the boundary between inputs and results.
  const main = $('main');
  const splitter = $('splitter');
  if (splitter && main) {
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
  }

  // Plot height handle (both interfaces): drag the bar under the plot to grow it
  // downward as far as you like; double-click resets to the default height.
  const handle = $('plot-resizer');
  const plot = $('plot');
  if (handle && plot) {
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      handle.setPointerCapture(ev.pointerId);
      document.body.classList.add('resizing-y');
      const startY = ev.clientY;
      const startH = plot.clientHeight;
      const move = (e) => { plot.style.height = Math.max(240, startH + e.clientY - startY) + 'px'; };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing-y');
        plotExpanded = false; syncExpandButton();
        saveLayout({ plotH: plot.clientHeight });
        replotToSize();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => { plotExpanded = false; syncExpandButton(); plot.style.height = ''; saveLayout({ plotH: null }); replotToSize(); });
  }
}

// ================================================================ 10. documents

const DOC_VERSION = 1;
const APP_VERSION = '0.2.0';
const AUTOSAVE_KEY = 'rootfit.autosave';
let documentCreated = null;
let workspaceDocument = null;

function buildDocument() {
  const now = new Date().toISOString();
  if (!documentCreated) documentCreated = now;
  return {
    ...(workspaceDocument || {}),
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

let savedAnalysisSnapshot = null;
let restoredUnsavedChanges = false;
function analysisSnapshot(doc = buildDocument()) {
  const inputs = JSON.parse(JSON.stringify(doc.inputs || {}));
  // Active-dataset controls duplicate the settings already stored with each dataset.
  if (inputs.datasets) {
    for (const key of ['active','analysis_type','histogram','data','formula','param_names','initial_guesses']) delete inputs[key];
    if (inputs.options) { delete inputs.options.x_min; delete inputs.options.x_max; }
  }
  return JSON.stringify({title:doc.title || '', notes:doc.notes || '', inputs,
    results:doc.results || null, results_payload:doc.results_payload || null, objects:doc.objects || []});
}
function markAnalysisSaved(doc) {
  savedAnalysisSnapshot = analysisSnapshot(doc);
  restoredUnsavedChanges = false;
}
function hasUnsavedAnalysis(doc) {
  return restoredUnsavedChanges || (savedAnalysisSnapshot !== null && analysisSnapshot(doc) !== savedAnalysisSnapshot);
}
function hasPendingTableEdits() {
  return !!(window.InsertData && window.InsertData.hasPendingEdits && window.InsertData.hasPendingEdits());
}
let internalNavigation = false;
function isWorkspaceDestination(href) {
  try {
    const here = new URL(window.location.href);
    const target = new URL(href, here);
    const directory = here.pathname.slice(0, here.pathname.lastIndexOf('/') + 1);
    return target.protocol === here.protocol && target.host === here.host
      && ['index.html','classic.html','modern.html','contact.html','about.html','uncertainties.html',''].some(page => target.pathname === directory + page);
  } catch (_) { return false; }
}
function prepareWorkspaceNavigation(href) {
  if (!isWorkspaceDestination(href) || hasPendingTableEdits()) return;
  clearTimeout(autosaveTimer);
  internalNavigation = autosaveNow() === true;
  setTimeout(() => { internalNavigation = false; }, 1000);
}
function handleWorkspaceLink(event) {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target?.closest?.('a[href]');
  if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download') || link.getAttribute('href').startsWith('#')) return;
  if (document.body.classList.contains('modern') && /(?:^|\/)uncertainties\.html(?:[?#]|$)/.test(link.getAttribute('href'))
      && !datasets[activeIdx]?.result?.response?.params?.length) {
    event.preventDefault();
    askDialog({title:'No fit results yet',
      message:'The selected dataset has no fit results. Run a fit here first, or continue to Analyze Data to work with the raw data.',
      accept:'Analyze raw data', cancel:'Make plot first', primaryCancel:true,
    }).then(accepted => {
      if (!accepted) return;
      const dataset = datasets[activeIdx];
      if (dataset?.id) workspaceDocument = {...workspaceDocument, workspace:{...workspaceDocument?.workspace, selected:dataset.derivedFrom || dataset.id}};
      prepareWorkspaceNavigation(link.href);
      if (internalNavigation) window.location.href = link.href;
    });
    return;
  }
  if (link.hasAttribute('data-analyze-results')) {
    const dataset = datasets[activeIdx];
    if (dataset?.id) {
      workspaceDocument = {...workspaceDocument, workspace: {
        ...workspaceDocument?.workspace,
        selected: dataset.result ? (dataset.result.objectId || dataset.id + ':fit') : (dataset.derivedFrom || dataset.id),
      }};
    }
  }
  prepareWorkspaceNavigation(link.href);
}
// Chrome exposes destinations for history navigation as well as link clicks.
window.navigation?.addEventListener('navigate', event => {
  if (event.navigationType !== 'reload' && !event.destination.sameDocument) prepareWorkspaceNavigation(event.destination.url);
});
window.addEventListener('pageshow', () => { internalNavigation = false; });
function warnBeforeLeaving(event) {
  if (internalNavigation) { internalNavigation = false; return; }
  if (!hasUnsavedAnalysis() && !hasPendingTableEdits()) return;
  event.preventDefault();
  event.returnValue = ''; // Chrome supplies its own standard unsaved-changes message.
}
window.addEventListener('beforeunload', warnBeforeLeaving);

function documentFilename(value) {
  const name = value.trim();
  if (!name || /^\.+$/.test(name)) throw new Error('Enter a filename.');
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) throw new Error('The filename cannot contain /, \\, :, *, ?, ", <, >, |, or control characters.');
  if (name.endsWith('.')) throw new Error('The filename cannot end with a period.');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('That filename is reserved by the operating system. Choose another name.');
  const filename = /\.json$/i.test(name) ? name : name + '.json';
  if (new TextEncoder().encode(filename).length > 240) throw new Error('Use a shorter filename (at most 240 bytes including .json).');
  return filename;
}

const DOWNLOAD_NAMES_KEY = 'rootfit.downloadNames';
function knownDownloadNames() {
  try { const names = JSON.parse(storageGet(DOWNLOAD_NAMES_KEY) || '[]'); return Array.isArray(names) ? names.filter(n => typeof n === 'string') : []; }
  catch (_) { return []; }
}
let savingDocument = false;
async function saveDocument() {
  if (savingDocument) return;
  savingDocument = true;
  try {
    const nativeSave = typeof window.showSaveFilePicker === 'function';
    const filename = await askDialog({title:'Save analysis', label:'Filename', value:fileBaseName() + '.json', accept:'Save',
      message:nativeSave ? 'Choose a save location next. The analysis is saved as a JSON document.' : 'The analysis is saved as a JSON document. Your browser controls the download location and duplicate filenames.',
      validate:documentFilename});
    if (filename === null) return;
    const text = JSON.stringify(buildDocument(), null, 1);
    if (nativeSave) {
      const handle = await window.showSaveFilePicker({suggestedName:filename, types:[{description:'Analysis document',accept:{'application/json':['.json']}}]});
      const existing = await handle.getFile();
      if (existing.size > 0 && !await askDialog({title:'Replace file', message:`“${handle.name}” already contains data. Replace it with this analysis?`, accept:'Replace', destructive:true})) return;
      const writable = await handle.createWritable();
      try { await writable.write(text); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch (_) {} throw error; }
      markAnalysisSaved(JSON.parse(text));
      autosave();
      showMessage('info', `Saved “${handle.name}”.`);
    } else {
      const names = knownDownloadNames();
      if (names.includes(filename) && !await askDialog({title:'Download another copy', message:`A download named “${filename}” was already requested in this browser. The page cannot check whether that file still exists or replace it. Your browser will handle the duplicate filename.`, accept:'Download copy'})) return;
      downloadText(text, filename, 'application/json');
      storageSet(DOWNLOAD_NAMES_KEY, JSON.stringify([...new Set([...names, filename])].slice(-100)));
      markAnalysisSaved(JSON.parse(text));
      autosave();
      showMessage('info', `Download requested: “${filename}”.`);
    }
  } catch (error) {
    if (error.name !== 'AbortError') await askDialog({title:'File not saved', message:`The file could not be saved. ${error.message}`, accept:'Close', cancel:null});
  } finally { savingDocument = false; }
}

function applyDocument(doc) {
  if (window.WorkspaceStore) {
    doc = window.WorkspaceStore.materialize(window.WorkspaceStore.normalize(doc));
    workspaceDocument = JSON.parse(JSON.stringify(doc));
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('This is not a ROOT-A-TRON 3000 document (expected a JSON object with "version" and "inputs").');
  }
  if (doc.version !== DOC_VERSION) {
    throw new Error(`Unsupported document version "${doc.version}" - this page understands version ${DOC_VERSION}.`);
  }
  if (!doc.inputs || typeof doc.inputs !== 'object') {
    throw new Error('The document has no "inputs" section.');
  }
  fitRequestVersion++;
  fitBusy = false;
  writeForm(doc.inputs);
  $('doc-title').value = doc.title || '';
  $('doc-notes').value = doc.notes || '';
  documentCreated = doc.created || null;

  lastResult = (doc.results && Array.isArray(doc.results.params)) ? doc.results : null;
  lastPayload = lastResult ? (doc.results_payload || null) : null;
  if (lastResult && !datasets.some(d => d.result)) {
    const owner = datasets.find(d => d.name === lastPayload?.dataset_name) || datasets[activeIdx];
    owner.result = {response:lastResult, payload:lastPayload};
  }
  const selectedResult = datasets[activeIdx].result;
  lastResult = selectedResult?.response || null;
  lastPayload = selectedResult ? {...selectedResult.payload, dataset_name:datasets[activeIdx].name} : null;
  showMessage('');
  if (lastResult) {
    renderReport(lastResult);
    drawPlot(lastResult);
  } else {
    document.dispatchEvent(new CustomEvent('rootfit:reset'));
    clearReport();
    $('plot').innerHTML = '<p class="placeholder">The plot appears here after a fit.</p>';
    setPngEnabled(false);
    lastDrawn = null;
  }
  markAnalysisSaved();
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
    if (window.WorkspaceStore) doc.revision = window.WorkspaceStore.read(localStorage).revision;
    applyDocument(doc);
  } catch (e) {
    showMessage('error', e.message);
    return false;
  }
  showMessage('info', `Loaded ${sourceName}${doc.title ? ` - "${doc.title}"` : ''}.`);
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
    const doc = buildDocument();
    if (window.WorkspaceStore) {
      workspaceDocument = window.WorkspaceStore.write(localStorage, {...doc, unsaved_changes:hasUnsavedAnalysis(doc)});
    } else localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({...doc, unsaved_changes:hasUnsavedAnalysis(doc)}));
    return true;
  } catch (error) {
    if (window.WorkspaceStore) { showMessage('error', error.message + ' Use Save to keep a complete copy of this session.'); return false; }
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...buildDocument(), results: null, unsaved_changes:true })); } catch (__) { /* give up */ }
    return false;
  }
}
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, 400);
}
window.addEventListener('pagehide', () => { if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveNow(); } });

function prepareAutosave(doc) {
  const options = doc?.inputs?.options;
  // The original single-panel UI defaulted to residuals. An old autosave
  // cannot tell that default apart from an explicit choice. New selections
  // use diagnostics; manually opened documents still restore their settings.
  if (options?.residuals !== 'residual' || Array.isArray(options.diagnostics)) return doc;
  return {
    ...doc,
    inputs: { ...doc.inputs, options: { ...options, residuals: 'none', diagnostics: [] } },
    // Do not pair unchecked controls with an old canvas containing residuals.
    results: null,
    results_payload: null,
  };
}

function restoreAutosave() {
  if (window.WorkspaceStore) {
    try { workspaceDocument = window.WorkspaceStore.migrate(localStorage); }
    catch (error) { showMessage('error', error.message); }
  }
  const text = storageGet(AUTOSAVE_KEY);
  if (!text) return false;
  try {
    const saved = JSON.parse(text);
    const restored = prepareAutosave(saved);
    applyDocument(restored);
    restoredUnsavedChanges = restored.unsaved_changes !== false;
    if (restored !== saved) {
      autosave();
      showMessage('info', 'Restored your data and settings. Residuals are now off by default. Run Fit to update the plot, or select Residuals under Optional plots to include them.');
    } else {
      showMessage('info', 'Restored your previous session from this browser (autosave). Use "Save" to keep a file.');
    }
    return true;
  } catch (_) {
    return false;
  }
}

function clearAutosave() {
  if (window.WorkspaceStore) autosaveNow();
  else storageRemove(AUTOSAVE_KEY);
}
window.addEventListener('storage', event => {
  if (!window.WorkspaceStore || event.key !== AUTOSAVE_KEY) return;
  if (autosaveTimer || hasPendingTableEdits() || document.querySelector('dialog[open]')) {
    showMessage('warn', 'This session changed in another tab. Save any local edits, then reload to use the latest shared session.');
    return;
  }
  try {
    const incoming = window.WorkspaceStore.read(localStorage);
    applyDocument(incoming);
    restoredUnsavedChanges = incoming.unsaved_changes !== false;
    showMessage('info', 'Updated from the shared session.');
  } catch (error) { showMessage('error', error.message); }
});

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

EXAMPLES.histogram = {"version": 1, "title": "Count histogram", "notes": "A count distribution fitted with a normalized Gaussian. Norm is the model\u2019s total area over the full real line.", "inputs": {"datasets": [{"name": "Count distribution", "analysis_type": "histogram", "x": "", "y": "", "ex": "", "ey": "", "histogram": {"source": "counts", "counts": "1 3 12 40 80 80 40 12 3 1", "edges": "0 1 2 3 4 5 6 7 8 9 10", "samples": "", "bins": "", "min": "", "max": "", "method": "poisson"}}], "active": 0, "formula": "gausn", "param_names": "norm, mean, sigma", "initial_guesses": "", "graph_title": "Count distribution", "x_title": "Measurement", "y_title": "Counts / unit X", "options": {"grid": true, "diagnostics": []}}};

EXAMPLES.multivariate = {"title": "Beam profile (R²→R surface)", "notes": "A 2-D Gaussian beam profile measured on a 7×7 grid (49 points): counts vs position (x0, x1), an R²→R fit. Poisson √N uncertainties on the counts. Model A·exp(−((x0−x0c)²+(x1−y0c)²)/(2σ²)) + background. Expected near A≈98, centre (0.38, −0.33), σ≈1.53, background≈4.8, χ²/NDF≈0.66. The fit draws the fitted surface over the measured points; edit a guess to see the fit move.", "inputs": {"datasets": [{"name": "Beam profile", "analysis_type": "multivariate", "x": "", "y": "", "ex": "", "ey": "", "mv": {"n": 2, "m": 1, "inNames": ["x0", "x1"], "inVals": ["-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4\n-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4\n-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4\n-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4\n-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4\n-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4\n-4\n-2.667\n-1.333\n0\n1.333\n2.667\n4", "-4\n-4\n-4\n-4\n-4\n-4\n-4\n-2.667\n-2.667\n-2.667\n-2.667\n-2.667\n-2.667\n-2.667\n-1.333\n-1.333\n-1.333\n-1.333\n-1.333\n-1.333\n-1.333\n0\n0\n0\n0\n0\n0\n0\n1.333\n1.333\n1.333\n1.333\n1.333\n1.333\n1.333\n2.667\n2.667\n2.667\n2.667\n2.667\n2.667\n2.667\n4\n4\n4\n4\n4\n4\n4"], "inErr": ["", ""], "outNames": ["counts"], "outVals": ["6\n7\n9\n13\n10\n5\n8\n8\n8\n28\n29\n30\n23\n9\n4\n16\n48\n78\n69\n27\n9\n7\n15\n59\n92\n93\n37\n9\n6\n10\n42\n52\n55\n23\n10\n6\n6\n13\n22\n16\n6\n3\n4\n10\n9\n5\n10\n5\n4"], "outErr": ["2.45\n2.65\n3\n3.61\n3.16\n2.24\n2.83\n2.83\n2.83\n5.29\n5.39\n5.48\n4.8\n3\n2\n4\n6.93\n8.83\n8.31\n5.2\n3\n2.65\n3.87\n7.68\n9.59\n9.64\n6.08\n3\n2.45\n3.16\n6.48\n7.21\n7.42\n4.8\n3.16\n2.45\n2.45\n3.61\n4.69\n4\n2.45\n1.73\n2\n3.16\n3\n2.24\n3.16\n2.24\n2"], "models": ["[0]*exp(-((x0-[1])*(x0-[1])+(x1-[2])*(x1-[2]))/(2*[3]*[3])) + [4]"], "parNames": "A, x0, y0, sigma, background", "parGuesses": "80, 0, 0, 2, 5"}}], "active": 0, "graph_title": "Beam profile", "x_title": "x0", "y_title": "x1", "options": {"grid": true}}};

async function loadExample(key) {
  const ex = EXAMPLES[key];
  if (!ex) return;
  const proceed = await askDialog({title:'Load example dataset',
    message:'Loading this example will replace the current datasets, fit settings, and results. Save your analysis first if you want to keep it.',
    accept:'Continue', cancel:'Cancel', destructive:true});
  if (!proceed) return;
  applyDocument({ revision:workspaceDocument?.revision || null, version: DOC_VERSION, title: ex.title, notes: ex.notes, inputs: ex.inputs, results: null });
  documentCreated = null;
  restoredUnsavedChanges = true;
  showMessage('info', `Loaded the example "${ex.title}". Press Fit.`);
  autosave();
}

function handleWorkspaceKeydown(ev) {
  if (ev.defaultPrevented || ev.isComposing || ev.repeat || document.querySelector('dialog[open]')) return;
  const modified = ev.ctrlKey || ev.metaKey;
  if (modified && !ev.altKey && ev.key.toLowerCase() === 'e') {
    ev.preventDefault(); openTable(); return;
  }
  if (ev.key !== 'Enter' || ev.altKey || ev.shiftKey) return;
  // Keep native activation and multiline editing; Ctrl/Cmd+Enter remains available.
  if (!modified && ev.target?.closest?.('textarea, select, button, a, summary, [contenteditable], [role="button"], .menu-title')) return;
  const fit = $('btn-fit');
  if (!fit || fit.disabled || fit.hidden) return;
  ev.preventDefault();
  runFit();
}

function openLoadDialog() { $('paste-area').value = ''; $('paste-dialog').showModal(); }
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
  'clear-all': clearAll,
  png: exportPng,
  svg: exportSvg,
  'plot-expand': toggleExpandPlot,
  fit: runFit,
  example: (el) => loadExample(el.dataset.example),
  health: checkHealth,
  about: openAbout,
  table: openTable,
  'dataset-add': addDataset,
  'dataset-duplicate': duplicateDataset,
  'dataset-rename': renameDataset,
  'dataset-remove': removeDataset,
  'reset-layout': resetLayout,
  'report-copy': copyReport,
  'report-txt': () => { if (lastResult) downloadText(reportText(lastResult), fileBaseName() + '-report.txt'); },
  'report-csv': () => { if (lastResult) downloadText(reportCsv(lastResult), fileBaseName() + '-report.csv', 'text/csv'); },
  help: (el) => showHelp(el.dataset.help, null),
};

/** Menu bar behavior, like TGMenuBar. */
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
  document.addEventListener('click', handleWorkspaceLink);
  initMenus();
  plotStyle = (window.PlotStyle && window.PlotStyle.load()) || null;
  syncExpandButton();
  initResizers();
  buildPlotOptionsPanel();
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const pop = $('plot-options-pop');
    if (pop && !pop.hidden) { closePlotOptions(); return; }
    if (plotExpanded) toggleExpandPlot();
  });
  for (const el of document.querySelectorAll('[data-action]')) {
    const fn = ACTIONS[el.dataset.action];
    if (fn) el.addEventListener('click', (ev) => { ev.stopPropagation(); fn(el); });
  }
  // "?" buttons
  for (const el of document.querySelectorAll('[data-help]')) {
    el.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); showHelp(el.dataset.help, el); });
  }
  $('help-pop').addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', hideHelp);

  // backend URL persists across visits (a setting, not part of a document)

  $('analysis-type').addEventListener('change', ev => {
    const type = ev.target.value;
    if (datasets.some(d => d.analysis_type === type)) changeAnalysisType(type);
    else requestNewDataset(type, false);
  });
  for (const button of document.querySelectorAll('[data-new-type]')) button.addEventListener('click', () => requestNewDataset(button.dataset.newType));
  $('dataset-type-cancel').addEventListener('click', () => $('dataset-type-dialog').close());
  for (const key of HISTOGRAM_FIELDS) $('hist-' + key).addEventListener('input', () => { syncAnalysisControls(); syncActiveFromColumns(); renderDatasetSelector(); autosave(); });
  $('btn-histogram').addEventListener('click', () => runFit(false));
  syncAnalysisControls();

  // data columns and datasets
  for (const c of COLUMNS) $('col-' + c).addEventListener('input', updateCounts);
  $('dataset-select').addEventListener('change', (ev) => setActiveDataset(parseInt(ev.target.value, 10)));
  $('fit-dataset-select')?.addEventListener('change', (ev) => setActiveDataset(parseInt(ev.target.value, 10)));
  renderDatasetSelector();

  // The Insert data table dialog wires its own events (insert-data.js).

  // the "Examples…" dropdown fills formula, names and guesses
  $('example-dataset')?.addEventListener('change', event => {
    const key = event.target.value;
    event.target.value = '';
    if (key) loadExample(key);
  });
  $('quick-pick').addEventListener('change', (ev) => applyFunctionExample(ev.target.value));

  for (const kind of DIAGNOSTIC_TYPES) $('diag-' + kind).addEventListener('change', syncDiagnosticControls);
  syncDiagnosticControls();

  // parameter table <-> comma lists
  for (const id of ['formula', 'param-names', 'initial-guesses', 'fit-xmin', 'fit-xmax']) $(id).addEventListener('input', () => {
    syncDatasetFit();
    if (!id.startsWith('fit-x')) renderParamTable();
  });
  $('param-table').addEventListener('input', paramTableToLists);
  renderParamTable();

  $('btn-fit').addEventListener('click', runFit);
  $('btn-png').addEventListener('click', exportPng);
  $('btn-table')?.addEventListener('click', openTable);

  document.addEventListener('keydown', handleWorkspaceKeydown);

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
  markAnalysisSaved();
  if (window.Multivariate) window.Multivariate.setAutosave(autosave);
  restoreAutosave();
  checkHealth();
  showFirstVisitSaveNotice();
}

init();
