/* Shared starting-value search for the Standard and Compact workspaces.
 * Search results are deliberately separate from fitted results and reports. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let dialog, host, session = null, undo = null, applying = false, refreshTimer;
  const number = value => Number.isFinite(value) ? fmtNum(value, 8) : '—';

  // Read the controls without calling readForm(): that routine synchronizes the
  // workspace and should not run continuously just to detect stale suggestions.
  function fingerprint() {
    const d = datasets[activeIdx];
    return JSON.stringify({
      dataset: d?.id || activeIdx, type: d?.analysis_type,
      columns: ['x', 'y', 'ex', 'ey'].map(c => el('col-' + c).value),
      settings: ['formula', 'param-names', 'initial-guesses', 'fit-xmin', 'fit-xmax'].map(id => el(id).value),
      equation: window.RootEquationEditor?.snapshot(),
      draft: el('fit-equation')?.value,
      exclusions: d?.exclusions, calculationError: d?.calculationError,
      pendingTable: hasPendingTableEdits(), backend: backendUrl(),
    });
  }

  function workspaceIsCurrent() {
    if (!window.WorkspaceStore) return true;
    try { return window.WorkspaceStore.read(localStorage).revision === (workspaceDocument?.revision || null); }
    catch (_) { return false; }
  }

  function warn(text) {
    el('parameter-search-error').textContent = text || '';
    el('parameter-search-error').hidden = !text;
  }

  function status(text) { el('parameter-search-status').textContent = text; }

  async function request(s, path, options = {}) {
    let response;
    try {
      response = await fetch(s.backend + path, { ...options, signal: AbortSignal.timeout(30000) });
    } catch (_) {
      throw new Error('The fitting service could not be reached. Check the connection and try again. Your starting values have been kept.');
    }
    let body;
    try { body = await response.json(); } catch (_) { /* static hosting or an older service */ }
    if ((response.status === 404 && path.endsWith('/prepare')) || response.status === 405) {
      throw new Error('This fitting service does not support starting-value search yet. Update the service or select a server with the latest version.');
    }
    if (!response.ok) {
      const error = new Error(body?.error || (response.status === 404
        ? 'This search is no longer available. Close this window and start a new search.'
        : 'The search could not be completed. Please try again.'));
      error.status = response.status;
      throw error;
    }
    if (!body || typeof body !== 'object') throw new Error('The fitting service returned an unreadable search response. Update the service and try again.');
    return body;
  }

  function setControls(s) {
    const busy = s?.preparing || s?.running || s?.cancelling;
    const unavailable = !!busy || !s?.parameters || !!s?.stale;
    el('parameter-search-choice').hidden = s?.mode !== 'choice';
    el('parameter-search-quick').disabled = unavailable;
    el('parameter-search-advanced').disabled = unavailable;
    el('parameter-search-setup').hidden = s?.mode !== 'advanced' || !s?.parameters;
    el('parameter-search-footer').hidden = s?.mode === 'choice';
    el('parameter-search-start').hidden = s?.mode === 'choice' || !!busy;
    el('parameter-search-start').textContent = s?.mode === 'quick' ? 'Guess again (20 seconds)' : 'Start search';
    el('parameter-search-settings').hidden = s?.mode !== 'quick' || !!busy;
    el('parameter-search-settings').disabled = unavailable;
    el('parameter-search-start').disabled = unavailable;
    el('parameter-search-apply').hidden = !s?.result;
    el('parameter-search-apply').disabled = !!busy || !s?.result || !!s.stale;
    el('parameter-search-stop').hidden = !s?.running;
    el('parameter-search-stop').disabled = !!s?.cancelling;
    el('parameter-search-effort').disabled = !!busy || !!s?.stale;
    dialog.querySelectorAll('[data-bound]').forEach(input => { input.disabled = !!busy || !!s?.stale; });
    el('parameter-search-progress').hidden = !s?.running;
    el('parameter-search-ranges').setAttribute('aria-busy', String(!!s?.preparing));
  }

  function stale(s, reason) {
    if (!s || s.stale) return;
    s.stale = true;
    warn(reason || 'The data, equation, or starting values changed. Close this window and open a new search for the current inputs.');
    setControls(s);
    if (s.running) stop(s, false);
  }

  function refresh() {
    if (applying || !host) return;
    const supported = datasets[activeIdx]?.analysis_type === 'xy';
    el('parameter-search-open').disabled = !supported || fitBusy;
    el('parameter-search-availability').textContent = supported
      ? 'Find starting values for your model, then review them before applying.'
      : 'Starting-value search is available for XY fits. Histogram and multivariate searches are not available yet.';
    const current = (session || undo) ? fingerprint() : null;
    if (session && current !== session.fingerprint) stale(session);
    if (undo && current !== undo.fingerprint) undo = null;
    el('parameter-search-undo').hidden = !undo;
  }

  function addWarnings(items, target) {
    target.replaceChildren();
    for (const text of items || []) {
      const item = document.createElement('li');
      item.textContent = String(text);
      target.append(item);
    }
    target.hidden = !target.children.length;
  }

  function rangeTable(s) {
    const tbody = el('parameter-search-ranges').querySelector('tbody');
    tbody.replaceChildren();
    for (const p of s.parameters) {
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = `${p.name || 'p' + p.index} [${p.index}]`;
      row.append(heading);
      const start = document.createElement('td');
      start.textContent = number(p.initial);
      row.append(start);
      for (const key of ['lower', 'upper']) {
        const cell = document.createElement('td'), input = document.createElement('input');
        input.type = 'text'; input.inputMode = 'decimal'; input.className = 'mono';
        input.value = String(p[key]); input.dataset.bound = key; input.dataset.index = p.index;
        input.setAttribute('aria-label', `${p.name || 'Parameter ' + p.index} ${key} search limit`);
        cell.append(input); row.append(cell);
      }
      tbody.append(row);
    }
  }

  function bounds(s) {
    return s.parameters.map(p => {
      const pair = ['lower', 'upper'].map(key => {
        const input = dialog.querySelector(`[data-index="${p.index}"][data-bound="${key}"]`);
        const value = input.value.trim() === '' ? NaN : Number(input.value);
        if (!Number.isFinite(value)) { input.focus(); throw new Error(`Enter a finite ${key} search limit for ${p.name || 'parameter ' + p.index}.`); }
        return value;
      });
      if (pair[0] > pair[1]) throw new Error(`${p.name || 'Parameter ' + p.index}: the lower search limit must be less than or equal to the upper limit.`);
      return pair;
    });
  }

  async function open() {
    refresh();
    if (el('parameter-search-open').disabled) return;
    let payload;
    try {
      // Commit any pending visual-equation edit before validating and capturing.
      el('fit-equation')?.dispatchEvent(new Event('change', { bubbles: true }));
      window.RootEquationEditor?.validate();
      if (hasPendingTableEdits()) throw new Error('Apply or cancel the pending data-table edits before searching.');
      if (!workspaceIsCurrent()) throw new Error('This workspace was updated in another tab. Reload this page to use the current data before searching. Save any local edits first.');
      if (datasets[activeIdx]?.calculationError) throw new Error(datasets[activeIdx].calculationError);
      const p = buildPayload(readForm());
      if (!p.formula) throw new Error('Enter a fit function before searching for starting values.');
      payload = Object.fromEntries(['x', 'y', 'ex', 'ey', 'formula', 'param_names', 'initial_guesses', 'x_range'].map(key => [key, p[key]]));
    } catch (error) { showMessage('error', error.message); return; }
    const s = session = { payload, backend: backendUrl(), fingerprint: fingerprint(), preparing: true, mode: 'choice' };
    warn(''); status('Preparing search ranges…');
    el('parameter-search-ranges').querySelector('tbody').replaceChildren();
    el('parameter-search-results').hidden = true;
    el('parameter-search-setup').hidden = true;
    addWarnings([], el('parameter-search-warnings'));
    el('parameter-search-description').textContent = 'Search for useful starting values for the current XY data and fit range. Excluded points are omitted. Current guesses stay in place until you choose Apply.';
    el('parameter-search-effort').value = '20';
    setControls(s); dialog.showModal();
    dialog.scrollTop = 0;
    clearInterval(refreshTimer); refreshTimer = setInterval(refresh, 500);
    try {
      const prepared = await request(s, '/parameter-search/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (session !== s || s.stale) return;
      if (!Array.isArray(prepared.parameters) || !prepared.parameters.length || prepared.parameters.some((p, i) => p.index !== i || !Number.isFinite(p.lower) || !Number.isFinite(p.upper))) {
        throw new Error('The fitting service did not return usable parameter ranges. Update the service and try again.');
      }
      s.parameters = prepared.parameters;
      rangeTable(s); addWarnings(prepared.warnings, el('parameter-search-warnings'));
      status(`Ready to search ${s.parameters.length} parameter${s.parameters.length === 1 ? '' : 's'} using ${prepared.n_points ?? payload.x.length} included points.`);
    } catch (error) { if (session === s) { warn(error.message); status('Search could not be prepared.'); } }
    finally { s.preparing = false; if (session === s) setControls(s); }
  }

  function advanced() {
    const s = session;
    if (!s?.parameters || s.preparing || s.running || s.cancelling) return;
    refresh();
    if (s.stale) return;
    s.mode = 'advanced';
    setControls(s);
    dialog.scrollTo({ top: 0, behavior: 'smooth' });
    el('parameter-search-effort').focus({ preventScroll: true });
  }

  function quick() {
    const s = session;
    if (!s?.parameters || s.preparing || s.running || s.cancelling) return;
    refresh();
    if (s.stale) return;
    s.mode = 'quick';
    el('parameter-search-effort').value = '20';
    start();
  }

  async function start() {
    const s = session;
    if (!s || s.running || s.preparing || s.stale) return;
    refresh();
    if (s.stale) return;
    let limits;
    try { limits = bounds(s); } catch (error) { warn(error.message); return; }
    warn(''); s.result = null; s.running = true; s.cancelling = false;
    s.jobId = null; s.cancelFailed = false; s.closeAfterStop = false;
    clearTimeout(s.timer); el('parameter-search-progress').value = 0;
    s.seconds = Number(el('parameter-search-effort').value); s.started = Date.now();
    el('parameter-search-results').hidden = true;
    status('Starting search…'); setControls(s);
    try {
      const job = await request(s, '/parameter-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s.payload, bounds: limits, time_budget: s.seconds }) });
      if (!job.job_id) throw new Error('The fitting service did not start a search. Please try again.');
      s.jobId = job.job_id;
      // A close, edit or cancellation can arrive while the creation request is
      // still in flight. Cancel the returned job rather than leaving it orphaned.
      if (session !== s || s.stale || s.cancelling) { await stop(s, false); return; }
      await poll(s);
    } catch (error) {
      s.running = false; s.cancelling = false;
      if (session === s) { status('Search could not continue.'); warn(error.message); setControls(s); }
    }
  }

  async function poll(s) {
    if (session !== s || !s.running || s.cancelling) return;
    try {
      const job = await request(s, '/parameter-search/' + encodeURIComponent(s.jobId));
      if (session !== s || s.cancelling || !s.running) return;
      refresh();
      if (s.stale) return;
      const progress = job.progress || {};
      const elapsed = Number.isFinite(progress.elapsed_seconds) ? progress.elapsed_seconds : (Date.now() - s.started) / 1000;
      const evaluations = Number.isFinite(progress.evaluations) ? progress.evaluations.toLocaleString() + ' evaluations' : 'Trying starting points';
      const best = Number.isFinite(progress.best_score) ? ` · best search score ${number(progress.best_score)}` : '';
      el('parameter-search-progress').value = Math.min(100, elapsed / s.seconds * 100);
      warn('');
      if (job.status === 'running') {
        status(`${Math.floor(elapsed)} s elapsed · ${evaluations}${best}`);
        s.timer = setTimeout(() => poll(s), 1000);
      } else {
        s.running = false;
        if (job.status === 'complete') showResult(s, job.result);
        else if (job.status === 'cancelled') status('Search stopped. Your starting values have been kept.');
        else { status('Search finished without a suggestion.'); warn(job.error || 'No usable starting values were found. Try narrower parameter ranges or different starting values.'); }
        setControls(s);
      }
    } catch (error) {
      if (error.status === 404 && session === s) {
        s.running = false; status('This search is no longer available.'); warn(error.message); setControls(s); return;
      }
      // A failed poll is not proof that the worker stopped. Keep Stop available
      // and retry so a temporary disconnect cannot enable a duplicate search.
      if (session === s && s.running && !s.cancelling) {
        status('Waiting for the fitting service…'); warn(error.message);
        s.timer = setTimeout(() => poll(s), 3000);
      }
    }
  }

  async function stop(s, closeAfter) {
    if (!s) return;
    s.cancelling = true; clearTimeout(s.timer);
    if (session === s) { status('Stopping search…'); setControls(s); }
    // start() will perform the cancellation once the pending POST yields an id.
    if (s.running && !s.jobId) { s.closeAfterStop = !!closeAfter; return; }
    try {
      if (s.jobId && s.running) {
        try { await request(s, '/parameter-search/' + encodeURIComponent(s.jobId), { method: 'DELETE' }); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      s.running = false; s.cancelling = false;
      if (session === s) {
        status('Search stopped. Your starting values have been kept.');
        setControls(s);
        if (closeAfter || s.closeAfterStop) dialog.close();
      }
    } catch (error) {
      s.cancelling = false;
      if (session === s) { warn(error.message + ' The search will stop at its time limit. You can retry Stop or close this window.'); status('Cancellation could not be confirmed.'); setControls(s); s.cancelFailed = true; }
    }
  }

  function drawPreview(s, curve) {
    const target = el('parameter-search-preview'); target.replaceChildren(); target.hidden = true;
    if (!Array.isArray(curve?.x) || !Array.isArray(curve?.y)) return;
    const inside = x => !s.payload.x_range || x >= s.payload.x_range[0] && x <= s.payload.x_range[1];
    const data = s.payload.x.map((x, i) => [x, s.payload.y[i]]).filter(([x, y]) => inside(x) && Number.isFinite(x) && Number.isFinite(y));
    const line = curve.x.map((x, i) => [x, curve.y[i]]).filter(([x, y]) => inside(x) && Number.isFinite(x) && Number.isFinite(y));
    const all = [...data, ...line];
    if (!data.length || !line.length) return;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [x, y] of all) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    if (xmin === xmax) { xmin -= 1; xmax += 1; }
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    if (![xmax - xmin, ymax - ymin].every(Number.isFinite)) return;
    const px = x => 72 + (x - xmin) / (xmax - xmin) * 540;
    const py = y => 212 - (y - ymin) / (ymax - ymin) * 180;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 640 255'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Suggested starting curve in blue and included measurements as dark points; X horizontal and Y vertical.');
    // Every interpolated value below is a finite number or a formatted number.
    svg.innerHTML = '<path class="search-axis" d="M72 25V212H618" />'
      + [0, .5, 1].map(t => `<text x="${72 + 540 * t}" y="232" text-anchor="middle">${number(xmin + (xmax - xmin) * t)}</text><text x="65" y="${216 - 180 * t}" text-anchor="end">${number(ymin + (ymax - ymin) * t)}</text>`).join('')
      + '<text x="342" y="252" text-anchor="middle">X</text><text x="20" y="20">Y</text>'
      + `<polyline class="search-curve" points="${line.map(([x, y]) => `${px(x)},${py(y)}`).join(' ')}" />`
      + data.filter((_, i) => i % Math.max(1, Math.ceil(data.length / 3000)) === 0)
        .map(([x, y]) => `<circle class="search-point" cx="${px(x)}" cy="${py(y)}" r="2.5" />`).join('');
    target.append(svg); target.hidden = false;
    if (data.length > 3000) {
      const note = document.createElement('p'); note.className = 'hint';
      note.textContent = 'The preview displays a sample of the measurements. The search uses all included points.';
      target.append(note);
    }
  }

  function showResult(s, result) {
    if (!Array.isArray(result?.values) || result.values.length !== s.parameters.length || !result.values.every(Number.isFinite)) {
      status('Search finished without usable values.'); warn('Try narrower parameter ranges or different starting values.'); return;
    }
    s.result = result;
    const tbody = el('parameter-search-values').querySelector('tbody'); tbody.replaceChildren();
    s.parameters.forEach((p, i) => {
      const row = document.createElement('tr');
      [`${p.name || 'p' + i} [${i}]`, s.payload.initial_guesses[i] ?? 'Default', number(result.values[i])].forEach((value, j) => {
        const cell = document.createElement(j === 0 ? 'th' : 'td');
        if (j === 0) cell.scope = 'row';
        cell.textContent = String(value); row.append(cell);
      }); tbody.append(row);
    });
    const score = Number.isFinite(result.score) ? `Search score: ${number(result.score)}${Number.isFinite(result.initial_score) ? ' (initial: ' + number(result.initial_score) + ')' : ''}. Lower is better. ` : '';
    el('parameter-search-score').textContent = score + 'Run Fit after applying to obtain fit uncertainties and goodness of fit.';
    addWarnings(result.warnings, el('parameter-search-result-warnings'));
    drawPreview(s, result.curve);
    el('parameter-search-results').hidden = false;
    status('Suggestions ready. Review the curve and values before applying.');
    // Scroll only the modal: scrollIntoView can also move the worksheet behind
    // it. Wait for the result layout before positioning its heading near top.
    requestAnimationFrame(() => {
      if (session !== s || !dialog.open || s.stale) return;
      const top = el('parameter-search-results').getBoundingClientRect().top
        - dialog.getBoundingClientRect().top + dialog.scrollTop
        - dialog.querySelector('.parameter-search-heading').offsetHeight - 16;
      dialog.scrollTo({ top, behavior: 'smooth' });
    });
  }

  function writeGuesses(value) {
    applying = true;
    try {
      el('initial-guesses').value = value;
      el('initial-guesses').dispatchEvent(new Event('input', { bubbles: true }));
      autosave();
    } finally { applying = false; }
  }

  function apply() {
    const s = session; refresh();
    if (!s?.result || s.stale || s.running) return;
    if (!workspaceIsCurrent()) { stale(s, 'This workspace was updated in another tab. Reload it before applying starting values. Save any local edits first.'); return; }
    const before = el('initial-guesses').value;
    // Retain full numerical precision in the actual guesses, regardless of how
    // many digits were shown in the review table.
    writeGuesses(s.result.values.map(String).join(', '));
    undo = { before, fingerprint: fingerprint() };
    s.fingerprint = undo.fingerprint;
    dialog.close(); refresh();
    showMessage('info', 'Suggested starting values applied. Run Fit to calculate the fit report and uncertainties.');
  }

  function undoApply() {
    refresh();
    if (!undo) return;
    if (!workspaceIsCurrent()) { undo = null; refresh(); showMessage('error', 'This workspace was updated in another tab. Reload it before changing starting values.'); return; }
    const before = undo.before; undo = null;
    writeGuesses(before); refresh();
    showMessage('info', 'Previous starting values restored. Run Fit when you are ready.');
  }

  function init() {
    const block = el('single-fit-block'); if (!block) return;
    host = document.createElement('div'); host.className = 'parameter-search-tools';
    host.innerHTML = '<div class="parameter-search-actions"><button type="button" id="parameter-search-open" class="primary" aria-describedby="parameter-search-availability"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><span>Auto-guess parameters…</span></button><button type="button" id="parameter-search-undo" hidden>Undo suggested values</button></div><p class="hint" id="parameter-search-availability"></p>';
    const parameterHelp = block.querySelector('[data-help="guesses"]');
    if (parameterHelp) {
      parameterHelp.replaceWith(host);
      host.querySelector('.parameter-search-actions').prepend(parameterHelp);
    } else {
      block.after(host);
    }
    dialog = document.createElement('dialog'); dialog.className = 'parameter-search-dialog';
    dialog.setAttribute('aria-labelledby', 'parameter-search-title'); dialog.setAttribute('aria-describedby', 'parameter-search-description');
    dialog.innerHTML = `<div class="parameter-search-heading"><h2 id="parameter-search-title">Auto-guess parameters</h2><button type="button" id="parameter-search-close">Close</button></div>
      <p id="parameter-search-description"></p>
      <p id="parameter-search-error" role="alert" hidden></p>
      <section id="parameter-search-choice" aria-labelledby="parameter-search-choice-title">
        <h3 id="parameter-search-choice-title">Find starting values automatically?</h3>
        <p>Try a quick 20-second guess using automatic search ranges, or choose the ranges and time limit yourself.</p>
        <div class="parameter-search-actions"><button type="button" id="parameter-search-quick" class="primary">Quick guess (20 seconds)</button><button type="button" id="parameter-search-advanced">Set ranges and time</button></div>
      </section>
      <div id="parameter-search-setup" hidden>
        <p>Review the search limits below. Narrow them using what you know about the model, especially for frequencies, widths, and parameter scales.</p>
        <div class="parameter-search-scroll"><table id="parameter-search-ranges"><thead><tr><th>Parameter</th><th>Search start</th><th>Lower limit</th><th>Upper limit</th></tr></thead><tbody></tbody></table></div>
        <p class="hint">These limits apply only to the search; Fit can move beyond them. Equal lower and upper limits hold a value constant during the search only.</p>
        <ul id="parameter-search-warnings" class="parameter-search-warnings" hidden></ul>
        <label class="parameter-search-effort" for="parameter-search-effort"><span>Time limit</span><select id="parameter-search-effort"><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="20" selected>20 seconds</option><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="180">3 minutes</option><option value="300">5 minutes</option></select></label>
        <p class="hint">The search can finish early. Longer searches may help with difficult models, but cannot guarantee the best solution or identify parameters the data do not determine.</p>
      </div>
      <p id="parameter-search-status" role="status" aria-live="polite"></p>
      <progress id="parameter-search-progress" max="100" value="0" aria-label="Search time elapsed" hidden></progress>
      <section id="parameter-search-results" aria-labelledby="parameter-search-results-title" hidden>
        <h3 id="parameter-search-results-title">Suggested starting values</h3>
        <div id="parameter-search-preview" hidden></div>
        <p id="parameter-search-score"></p>
        <ul id="parameter-search-result-warnings" class="parameter-search-warnings" hidden></ul>
        <div class="parameter-search-scroll"><table id="parameter-search-values"><thead><tr><th>Parameter</th><th>Current guess</th><th>Suggested guess</th></tr></thead><tbody></tbody></table></div>
      </section>
      <div class="parameter-search-footer" id="parameter-search-footer"><button type="button" id="parameter-search-start">Start search</button><button type="button" id="parameter-search-settings">Set ranges and time</button><button type="button" id="parameter-search-stop" hidden>Stop search</button><button type="button" id="parameter-search-apply" class="primary" disabled>Apply suggested values</button></div>`;
    document.body.append(dialog);
    el('parameter-search-open').onclick = open;
    el('parameter-search-undo').onclick = undoApply;
    el('parameter-search-quick').onclick = quick;
    el('parameter-search-advanced').onclick = advanced;
    el('parameter-search-settings').onclick = advanced;
    el('parameter-search-start').onclick = start;
    el('parameter-search-stop').onclick = () => stop(session, false);
    el('parameter-search-apply').onclick = apply;
    dialog.addEventListener('input', event => {
      if (!event.target.matches('[data-bound]') || !session?.result) return;
      session.result = null;
      el('parameter-search-results').hidden = true;
      status('Search limits changed. Start a new search to get suggestions within these limits.');
      setControls(session);
    });
    const close = () => {
      if (session?.running && !session.cancelFailed) stop(session, true);
      else dialog.close();
    };
    el('parameter-search-close').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    const isOutside = event => {
      if (event.target !== dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', event => { pressedOutside = isOutside(event); });
    dialog.addEventListener('pointercancel', () => { pressedOutside = false; });
    dialog.addEventListener('click', event => {
      // Releasing a text selection outside the window should not dismiss it.
      const dismiss = pressedOutside && isOutside(event);
      pressedOutside = false;
      if (dismiss) close();
    });
    dialog.addEventListener('close', () => {
      const s = session; session = null;
      clearInterval(refreshTimer); clearTimeout(s?.timer);
      if (s?.running) stop(s, false);
      refresh(); el('parameter-search-open').focus();
    });
    const changed = event => { if (!dialog.contains(event.target)) refresh(); };
    document.addEventListener('input', changed);
    document.addEventListener('change', changed);
    document.addEventListener('rootfit:reset', refresh);
    document.addEventListener('rootfit:draw', refresh);
    // Programmatic dataset/model selections also rebuild these controls.
    new MutationObserver(refresh).observe(el('param-table'), { childList: true, subtree: true });
    new MutationObserver(refresh).observe(el('dataset-select'), { childList: true });
    new MutationObserver(refresh).observe(el('btn-fit'), { attributes: true, attributeFilter: ['disabled'] });
    window.addEventListener('storage', event => {
      if (event.key !== 'rootfit.autosave' && event.key !== null) return;
      undo = null;
      if (session) stale(session, 'The saved workspace changed in another tab. Close this window and reload the workspace before searching again. Save any local edits first.');
      refresh();
    });
    window.addEventListener('pagehide', () => {
      const s = session;
      if (s?.jobId && s.running) fetch(s.backend + '/parameter-search/' + encodeURIComponent(s.jobId), { method: 'DELETE', keepalive: true }).catch(() => {});
    });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
