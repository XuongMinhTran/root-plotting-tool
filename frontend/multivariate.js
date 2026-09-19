/*
 * multivariate.js — the "Multivariate (R^n -> R^m)" analysis type for the
 * Classic workspace. It is additive: it owns its own data-entry grid, model
 * editors and result table, and app.js calls into window.Multivariate at a few
 * well-defined moments (load a dataset, build the fit payload, render a result).
 * The XY and histogram paths are untouched.
 *
 * Per-dataset state lives on dataset.mv:
 *   { n, m, inNames[], inVals[], inErr[], outNames[], outVals[], outErr[],
 *     models[], parNames, parGuesses }
 * Columns are stored as textarea strings, exactly like XY stores x/y as strings.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let current = null;             // active dataset
  const cb = { autosave: null };  // app.js wires autosave here
  const sup = (n) => '⁰¹²³⁴⁵⁶⁷⁸⁹'.split('').reduce((s, d, i) => s.replace(new RegExp(i, 'g'), d), String(n));

  function defaultMv() {
    return {
      n: 2, m: 1,
      inNames: ['x0', 'x1'], inVals: ['', ''], inErr: ['', ''],
      outNames: ['y0'], outVals: [''], outErr: [''],
      models: ['[0]*x0 + [1]*x1 + [2]'],
      parNames: '', parGuesses: '',
    };
  }

  function ensure(d) {
    if (!d.mv) d.mv = defaultMv();
    const mv = d.mv;
    const fix = (arr, len, fill) => {
      arr = Array.isArray(arr) ? arr.slice(0, len) : [];
      while (arr.length < len) arr.push(typeof fill === 'function' ? fill(arr.length) : fill);
      return arr;
    };
    mv.n = Math.max(1, Math.min(20, mv.n | 0 || 1));
    mv.m = Math.max(1, Math.min(20, mv.m | 0 || 1));
    mv.inNames = fix(mv.inNames, mv.n, (i) => 'x' + i);
    mv.inVals = fix(mv.inVals, mv.n, '');
    mv.inErr = fix(mv.inErr, mv.n, '');
    mv.outNames = fix(mv.outNames, mv.m, (i) => 'y' + i);
    mv.outVals = fix(mv.outVals, mv.m, '');
    mv.outErr = fix(mv.outErr, mv.m, '');
    mv.models = fix(mv.models, mv.m, '');
    mv.parNames = mv.parNames || '';
    mv.parGuesses = mv.parGuesses || '';
    return mv;
  }

  // tolerant number parse: newlines / commas / tabs / spaces
  function parseCol(text) {
    const values = [], bad = [];
    for (const tok of String(text || '').split(/[\s,]+/)) {
      if (tok === '') continue;
      const v = Number(tok);
      if (Number.isFinite(v)) values.push(v); else bad.push(tok);
    }
    return { values, bad };
  }

  function splitList(text) {
    return String(text || '').split(',').map((s) => s.trim()).filter((s, i, a) => s !== '' || i < a.length);
  }

  // ---------------------------------------------------------------- rendering
  function buildStatic() {
    const data = $('multivariate-data');
    const model = $('multivariate-model');
    if (!data || !model) return false;
    if (data.dataset.built) return true;
    data.innerHTML =
      '<div class="mv-dims">' +
      '<label>Inputs (n)<input type="number" id="mv-n" min="1" max="20" step="1"></label>' +
      '<label>Outputs (m)<input type="number" id="mv-m" min="1" max="20" step="1"></label>' +
      '<span class="mv-shape" id="mv-shape"></span></div>' +
      '<div class="mv-section-label">Inputs</div><div id="mv-input-cols" class="mv-cols"></div>' +
      '<div class="mv-section-label">Outputs</div><div id="mv-output-cols" class="mv-cols"></div>' +
      '<p class="hint">One value per line (commas, tabs and spaces also work). Every column needs the same number of rows. Uncertainties are optional: one value for the whole column, or one per row.</p>';
    model.innerHTML =
      '<div id="mv-models" class="mv-models"></div>' +
      '<div class="mv-params">' +
      '<label>Parameter names<input id="mv-par-names" class="mono" placeholder="a, b, c" spellcheck="false"></label>' +
      '<label>Initial guesses<input id="mv-par-guesses" class="mono" placeholder="1, 1, 1" spellcheck="false"></label>' +
      '</div>' +
      '<p class="hint">Write each model with inputs <code>x0</code>, <code>x1</code>, … and parameters <code>[0]</code>, <code>[1]</code>, …. A parameter that appears in more than one output is shared across them. Names and guesses are listed in parameter-index order.</p>';
    data.dataset.built = 'true';

    $('mv-n').addEventListener('change', () => onDims());
    $('mv-m').addEventListener('change', () => onDims());
    for (const id of ['mv-par-names', 'mv-par-guesses']) $(id).addEventListener('input', save);
    return true;
  }

  function colBlock(kind, i, name, val, err) {
    // kind: 'in' | 'out'
    return '<div class="mv-col">' +
      '<input class="mv-name mono" data-mv="' + kind + 'Name" data-i="' + i + '" value="' + esc(name) + '" aria-label="name of ' + kind + ' column ' + (i + 1) + '">' +
      '<textarea class="mv-val" data-mv="' + kind + 'Val" data-i="' + i + '" rows="7" spellcheck="false" placeholder="values"></textarea>' +
      '<textarea class="mv-err" data-mv="' + kind + 'Err" data-i="' + i + '" rows="3" spellcheck="false" placeholder="uncertainty (optional)"></textarea>' +
      '<span class="mv-count" data-mv="' + kind + 'Count" data-i="' + i + '"></span></div>';
  }

  function renderGrids(mv) {
    $('mv-n').value = mv.n;
    $('mv-m').value = mv.m;
    $('mv-shape').textContent = 'R' + sup(mv.n) + ' → R' + sup(mv.m);
    $('mv-input-cols').innerHTML = mv.inNames.map((nm, i) => colBlock('in', i, nm, mv.inVals[i], mv.inErr[i])).join('');
    $('mv-output-cols').innerHTML = mv.outNames.map((nm, i) => colBlock('out', i, nm, mv.outVals[i], mv.outErr[i])).join('');
    $('mv-models').innerHTML = mv.outNames.map((nm, i) =>
      '<label class="mv-model-row"><span class="mv-model-label" data-model-label="' + i + '">' + esc(nm) + ' =</span>' +
      '<input class="mono grow" data-mv="model" data-i="' + i + '" value="' + esc(mv.models[i] || '') + '" spellcheck="false" placeholder="[0]*x0 + [1]"></label>').join('');
    // fill textareas + wire listeners
    for (const el of $('multivariate-data').querySelectorAll('[data-mv]')) {
      const k = el.dataset.mv, i = +el.dataset.i;
      if (k === 'inVal') el.value = mv.inVals[i] || '';
      else if (k === 'inErr') el.value = mv.inErr[i] || '';
      else if (k === 'outVal') el.value = mv.outVals[i] || '';
      else if (k === 'outErr') el.value = mv.outErr[i] || '';
      if (k.endsWith('Count')) continue;
      el.oninput = onCell;
    }
    for (const el of $('mv-models').querySelectorAll('[data-mv="model"]')) el.oninput = onCell;
    $('mv-par-names').value = mv.parNames || '';
    $('mv-par-guesses').value = mv.parGuesses || '';
    updateCounts();
  }

  function updateCounts() {
    if (!current || !current.mv) return;
    const mv = current.mv;
    const n0 = parseCol(mv.inVals[0]).values.length;
    const set = (kind, i, text) => {
      const el = $('multivariate-data').querySelector('[data-mv="' + kind + 'Count"][data-i="' + i + '"]');
      if (el) el.textContent = text;
    };
    mv.inVals.forEach((v, i) => {
      const p = parseCol(v);
      set('in', i, p.bad.length ? p.values.length + ' (check ' + p.bad.length + ')' : String(p.values.length));
    });
    mv.outVals.forEach((v, i) => {
      const p = parseCol(v);
      set('out', i, p.bad.length ? p.values.length + ' (check ' + p.bad.length + ')' : String(p.values.length));
    });
    const shape = $('mv-shape');
    if (shape) shape.textContent = 'R' + sup(mv.n) + ' → R' + sup(mv.m) + (n0 ? '  ·  ' + n0 + ' rows' : '');
  }

  // ------------------------------------------------------------- DOM <-> state
  function readDom() {
    if (!current) return;
    const mv = ensure(current);
    for (const el of $('multivariate-data').querySelectorAll('[data-mv]')) {
      const k = el.dataset.mv, i = +el.dataset.i;
      if (k === 'inName') mv.inNames[i] = el.value;
      else if (k === 'inVal') mv.inVals[i] = el.value;
      else if (k === 'inErr') mv.inErr[i] = el.value;
      else if (k === 'outName') mv.outNames[i] = el.value;
      else if (k === 'outVal') mv.outVals[i] = el.value;
      else if (k === 'outErr') mv.outErr[i] = el.value;
    }
    for (const el of $('mv-models').querySelectorAll('[data-mv="model"]')) mv.models[+el.dataset.i] = el.value;
    mv.parNames = $('mv-par-names').value;
    mv.parGuesses = $('mv-par-guesses').value;
  }

  function onCell(ev) {
    readDom();
    // keep the model labels in step with output names
    if (ev && ev.target.dataset.mv === 'outName') {
      const i = +ev.target.dataset.i;
      const lab = $('mv-models').querySelector('[data-model-label="' + i + '"]');
      if (lab) lab.textContent = ev.target.value + ' =';
    }
    updateCounts();
    cb.autosave && cb.autosave();
  }

  function save() { readDom(); cb.autosave && cb.autosave(); }

  function onDims() {
    if (!current) return;
    readDom();
    const mv = current.mv;
    mv.n = Math.max(1, Math.min(20, +$('mv-n').value | 0 || 1));
    mv.m = Math.max(1, Math.min(20, +$('mv-m').value | 0 || 1));
    ensure(current);
    renderGrids(mv);
    cb.autosave && cb.autosave();
  }

  // --------------------------------------------------------------- public API
  function load(d) {
    if (!buildStatic()) return;
    current = d;
    const mv = ensure(d);
    renderGrids(mv);
  }

  function buildPayload(d) {
    const mv = ensure(d);
    const inputs = [], input_errors = [], input_names = [];
    let N = null;
    for (let i = 0; i < mv.n; i++) {
      const p = parseCol(mv.inVals[i]);
      const name = (mv.inNames[i] || 'x' + i).trim() || 'x' + i;
      if (p.bad.length) throw new Error(name + ': "' + p.bad[0] + '" is not a number.');
      if (!p.values.length) throw new Error('Enter values for input ' + name + '.');
      if (N === null) N = p.values.length;
      else if (p.values.length !== N) throw new Error(name + ' has ' + p.values.length + ' rows but input ' + (mv.inNames[0] || 'x0') + ' has ' + N + '. Every column needs the same number of rows.');
      inputs.push(p.values);
      input_names.push(name);
      input_errors.push(errorCol(mv.inErr[i], N, name));
    }
    const outputs = [], output_errors = [], output_names = [], models = [];
    for (let k = 0; k < mv.m; k++) {
      const p = parseCol(mv.outVals[k]);
      const name = (mv.outNames[k] || 'y' + k).trim() || 'y' + k;
      if (p.bad.length) throw new Error(name + ': "' + p.bad[0] + '" is not a number.');
      if (p.values.length !== N) throw new Error(name + ' has ' + p.values.length + ' rows but the inputs have ' + N + '.');
      outputs.push(p.values);
      output_names.push(name);
      output_errors.push(errorCol(mv.outErr[k], N, name));
      const f = (mv.models[k] || '').trim();
      if (!f) throw new Error('Enter a model for ' + name + '.');
      models.push(f);
    }
    if (N * mv.m <= maxParamIndex(models) + 1) throw new Error('Add more data: there are fewer measurements than parameters to fit.');
    return {
      n_inputs: mv.n, n_outputs: mv.m,
      inputs, input_errors, outputs, output_errors,
      models, input_names, output_names,
      param_names: splitList(mv.parNames),
      initial_guesses: splitList(mv.parGuesses).map((g) => (g === '' ? null : g)),
      title: ($('graph-title') && $('graph-title').value) || '',
      plot: { grid: true },
      dataset_name: d.name,
      analysis_type: 'multivariate',
    };
  }

  function errorCol(text, N, label) {
    const p = parseCol(text);
    if (p.bad.length) throw new Error('Uncertainty for ' + label + ': "' + p.bad[0] + '" is not a number.');
    if (p.values.some((v) => v < 0)) throw new Error('Uncertainties for ' + label + ' must be zero or positive.');
    if (![0, 1, N].includes(p.values.length)) throw new Error('Uncertainty for ' + label + ': ' + p.values.length + ' values for ' + N + ' rows. Enter one value, ' + N + ' values, or leave it blank.');
    return p.values;
  }

  function maxParamIndex(models) {
    let hi = -1;
    for (const m of models) for (const t of String(m).match(/\[(\d+)\]/g) || []) hi = Math.max(hi, +t.slice(1, -1));
    return hi;
  }

  function label(d) {
    const mv = d.mv || defaultMv();
    const n = parseCol((mv.inVals || [''])[0]).values.length;
    return 'R' + sup(mv.n) + '→R' + sup(mv.m) + ' (' + n + ' points)';
  }

  // ------------------------------------------------------------------- report
  function fmtNum(v, sig) {
    if (v == null || !Number.isFinite(v)) return '—';
    return window.fmtNum ? window.fmtNum(v, sig) : Number(v).toPrecision(sig || 6);
  }
  function fmtPair(v, e) {
    return window.fmtPair ? window.fmtPair(v, e) : (fmtNum(v, 6) + ' ± ' + fmtNum(e, 3));
  }

  function renderReport(r, payload) {
    const rows = r.params.map((p) =>
      '<tr><td>' + esc(p.name) + '</td><td class="num" title="' + p.value + ' ± ' + p.error + '">' +
      fmtPair(p.value, p.error) + '</td><td class="num">' + fmtNum(p.value, 8) + '</td><td class="num">' +
      fmtNum(p.error, 4) + '</td></tr>').join('');
    const conv = r.converged
      ? '<span class="converged">' + esc(r.status_message) + '</span>'
      : '<span class="not-converged">' + esc(r.status_message) + '</span>';
    const modelList = (r.models || []).map((f, k) =>
      '<li><code>' + esc((r.output_names && r.output_names[k]) || ('y' + k)) + ' = ' + esc(f) + '</code></li>').join('');
    const resid = (r.residual_summary || []).map((s) =>
      '<tr><td>' + esc(s.name) + '</td><td class="num">' + fmtNum(s.rms_residual, 4) + '</td><td class="num">' +
      fmtNum(s.mean_pull, 3) + '</td><td class="num">' + fmtNum(s.std_pull, 3) + '</td></tr>').join('');
    const shape = 'R' + sup(r.n_inputs) + ' → R' + sup(r.n_outputs);

    $('report').innerHTML =
      '<p>' + shape + ' fit' + (payload && payload.dataset_name ? ' on <span class="ds-name">' + esc(payload.dataset_name) + '</span>,' : '') +
      ' ' + r.n_points + ' points, ' + r.params.length + ' parameter(s). ' + conv + '</p>' +
      '<ul class="mv-model-summary">' + modelList + '</ul>' +
      '<table class="report-table"><thead><tr><th>Parameter</th><th>Value ± uncertainty</th>' +
      '<th>Value (8 s.f.)</th><th>Uncertainty (4 s.f.)</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="summary">' +
      '<div class="stat"><span class="k">χ²</span><span class="v">' + fmtNum(r.chi2) + '</span></div>' +
      '<div class="stat"><span class="k">NDF</span><span class="v">' + r.ndf + '</span></div>' +
      '<div class="stat"><span class="k">χ² / NDF</span><span class="v">' + (r.chi2_ndf == null ? '—' : fmtNum(r.chi2_ndf, 4)) + '</span></div>' +
      '<div class="stat"><span class="k">p-value</span><span class="v">' + fmtNum(r.prob, 4) + '</span></div></div>' +
      (resid ? '<table class="report-table mv-residuals"><thead><tr><th>Output</th><th>RMS residual</th>' +
        '<th>Mean pull</th><th>Pull spread</th></tr></thead><tbody>' + resid + '</tbody></table>' : '');
  }

  window.Multivariate = {
    load, buildPayload, renderReport, label,
    setAutosave(fn) { cb.autosave = fn; },
    isBuilt() { return buildStatic(); },
    defaultMv,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildStatic);
  else buildStatic();
})();
