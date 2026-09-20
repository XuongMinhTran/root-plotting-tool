// insert-data.js — the shared "Insert data" table editor (window.InsertData).
//
// One data-entry system for the plotting tool (Compact + Standard) and for
// Analyze Data. The page supplies a small *host adapter*; this module owns the
// dialog behaviour and edits a working COPY of the datasets. "Done" commits the
// copy through host.commit(); "Cancel" (or Escape) discards it.
//
// The module drives whatever #table-dialog markup the page already provides, so
// each interface keeps its own dialog chrome and styling. It depends on nothing
// from app.js: the few helpers it needs are kept private below.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // --- self-contained helpers (no dependency on app.js) ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /** Split a column of text into its raw tokens (numbers or not). */
  function tokens(text) {
    return String(text || '').split(/[\s,;]+/).filter((t) => t !== '');
  }
  function defaultFitSettings() { return { formula: '[0]*x+[1]', param_names: '', initial_guesses: '', x_min: '', x_max: '' }; }
  function normalizeFitSettings(settings = {}) {
    const defaults = defaultFitSettings();
    const fit = Object.fromEntries(Object.keys(defaults).map((key) => [key, String(settings[key] ?? defaults[key])]));
    if (settings.equation && typeof settings.equation === 'object' && settings.equation.formula === fit.formula) {
      fit.equation = JSON.parse(JSON.stringify(settings.equation));
    }
    return fit;
  }
  function duplicateDatasetInto(list, index) {
    const original = list[index];
    const base = original.name + ' (copy)';
    let name = base, suffix = 2;
    while (list.some((d) => d.name === name)) name = original.name + ' (copy ' + suffix++ + ')';
    const copy = JSON.parse(JSON.stringify(original));
    if (window.WorkspaceStore) copy.id = window.WorkspaceStore.id();
    delete copy.derivedFrom;
    if (copy.result) delete copy.result.objectId;
    copy.name = name;
    list.splice(index + 1, 0, copy);
    return index + 1;
  }

  // --- module state (the working copy the dialog edits) ---
  let H = null;                       // the current host adapter
  let tableDatasets = null;
  let tableActive = 0;
  let tableDeleted = false;
  let renderedGridSnapshot = '[]';
  let wired = false;
  let histBuilt = false;
  let mvMounted = false;
  let mvHomes = null;                 // remembered panel positions for the multivariate editor
  // Grid column order: Y errors before X errors, so a pasted "x y yerr" block lands right.
  const GRID_COLS = ['x', 'y', 'ey', 'ex'];
  const MIN_ROWS = 12;
  const IMPORT_TARGETS = [['x', 'X'], ['y', 'Y'], ['ey', 'Y err'], ['ex', 'X err'], ['', 'ignore']];
  const TYPE_LABELS = { xy: 'XY data', histogram: 'Histogram', multivariate: 'Multivariate' };
  const HIST_MAP = { 'ins-hist-source': 'source', 'ins-hist-samples': 'samples', 'ins-hist-counts': 'counts', 'ins-hist-bins': 'bins', 'ins-hist-min': 'min', 'ins-hist-max': 'max', 'ins-hist-edges': 'edges' };
  function defaultHistogram() { return { source: 'samples', samples: '', counts: '', edges: '', bins: '', min: '', max: '', method: 'poisson' }; }
  function deepClone(d) { return JSON.parse(JSON.stringify(d)); }
  function isEmptyDataset(d) {
    if (!d.analysis_type) return true;
    if (d.analysis_type === 'histogram') { const h = d.histogram || {}; return !tokens(h.samples).length && !tokens(h.counts).length; }
    if (d.analysis_type === 'multivariate') { const mv = d.mv; return !mv || !(mv.inVals || []).some((v) => tokens(v).length); }
    return !tokens(d.x).length && !tokens(d.y).length;   // xy
  }

  function fitEnabled() { return !!(H && H.fitSettings); }
  function msg(kind, text) { if (H && H.message) H.message(kind, text); }

  // ---------------------------------------------------------------- open / commit

  function open(host) {
    H = host;
    ensureWired();
    tableDatasets = H.datasets().map(deepClone);
    tableActive = Math.max(0, Math.min(H.activeIndex(), tableDatasets.length - 1));
    // A brand-new blank dataset defaults to XY so the grid is ready to type in.
    if (!tableDatasets[tableActive].analysis_type) tableDatasets[tableActive].analysis_type = 'xy';
    tableDeleted = false;
    const importPanel = $('import-panel'); if (importPanel) importPanel.hidden = true;
    render();
    $('table-dialog').showModal();
    focusEntry();
  }

  function focusEntry() {
    setTimeout(() => {
      const type = tableDatasets[tableActive].analysis_type;
      let el = null;
      if (type === 'xy') { const g = $('grid'); el = g && g.querySelector('tbody input'); }
      else if (type === 'histogram') el = $('ins-hist-samples') || $('ins-hist-counts');
      if (el) el.focus();
    }, 50);
  }

  /** Re-render the whole dialog body for the active dataset. */
  function render() {
    renderTypeSelector();
    renderTabs();
    renderEntry();
  }

  function renderTypeSelector() {
    const box = $('insert-type-tabs');
    if (!box) return;
    const types = (H && H.types) || [];
    if (types.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const active = tableDatasets[tableActive].analysis_type;
    box.innerHTML = '';
    for (const t of types) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'type-tab' + (t === active ? ' active' : '');
      b.textContent = TYPE_LABELS[t] || t;
      b.setAttribute('aria-pressed', t === active ? 'true' : 'false');
      b.addEventListener('click', () => setType(t));
      box.appendChild(b);
    }
  }

  function defaultName() {
    const names = new Set(tableDatasets.map((d) => d.name));
    let i = tableDatasets.length + 1;
    while (names.has('Dataset ' + i)) i++;
    return 'Dataset ' + i;
  }

  /** Switch to the first dataset of `type`, converting a blank one or creating a new one. */
  function setType(type) {
    if (type === tableDatasets[tableActive].analysis_type) return;
    if (readCurrentEntry() === false) return;
    if (tableDatasets[tableActive].analysis_type === 'multivariate') unmountMultivariate();
    let next = tableDatasets.findIndex((d) => d.analysis_type === type);
    if (next < 0) {
      if (isEmptyDataset(tableDatasets[tableActive])) {
        tableDatasets[tableActive] = H.newDataset(tableDatasets[tableActive].name, type);
        next = tableActive;
      } else {
        tableDatasets.push(H.newDataset(defaultName(), type));
        next = tableDatasets.length - 1;
      }
    }
    tableActive = next;
    render();
  }

  /** Show the entry area for the active dataset's type; hide the others. */
  function renderEntry() {
    const type = tableDatasets[tableActive].analysis_type || 'xy';
    if (fitEnabled() && type !== 'multivariate') writeTableFit();
    for (const button of document.querySelectorAll('[data-taction]')) {
      if (['add-rows', 'delete-empty', 'import'].includes(button.dataset.taction)) button.disabled = type !== 'xy';
      if (['duplicate', 'delete'].includes(button.dataset.taction)) button.disabled = !tableDatasets[tableActive].analysis_type;
    }
    for (const input of document.querySelectorAll('.table-fit-settings input')) input.disabled = !tableDatasets[tableActive].analysis_type;
    const fs = document.querySelector('.table-fit-settings');
    if (fs) fs.hidden = !fitEnabled() || type === 'multivariate';
    const gridWrap = $('grid-wrap'); if (gridWrap) gridWrap.hidden = type !== 'xy';
    const hist = $('insert-histogram'); if (hist) hist.hidden = type !== 'histogram';
    const mv = $('insert-multivariate'); if (mv) mv.hidden = type !== 'multivariate';
    if (type !== 'multivariate') unmountMultivariate();
    if (type === 'xy') renderGrid();
    else if (type === 'histogram') renderHistogram();
    else if (type === 'multivariate') mountMultivariate();
    else renderGrid();
  }

  function tableDone() {
    if (fitEnabled() && tableDatasets[tableActive].analysis_type !== 'multivariate') readTableFit();
    if (readCurrentEntry() === false) return;
    unmountMultivariate();
    const out = tableDatasets;
    const activeIndex = Math.min(tableActive, out.length - 1);
    const deleted = tableDeleted;
    tableDeleted = false;
    tableDatasets = null;
    H.commit({ datasets: out, activeIndex, deleted });   // host re-renders the panel
    $('table-dialog').close();
  }

  function tableCancel() {
    tableDeleted = false;
    unmountMultivariate();
    tableDatasets = null;
    $('table-dialog').close();
    if (H && H.afterClose) H.afterClose();               // resync the panel after discarding
  }

  /** Read whatever entry area is showing into the active working-copy dataset. */
  function readCurrentEntry() {
    const type = tableDatasets[tableActive].analysis_type;
    if (type === 'histogram') { readHistogram(); return true; }
    if (type === 'multivariate') return true;   // window.Multivariate writes the working copy live
    return readGridToDataset();
  }

  // ---------------------------------------------------------------- tabs

  function renderTabs() {
    const box = $('dataset-tabs');
    box.innerHTML = '';
    tableDatasets.forEach((d, i) => {
      if (!d.analysis_type || d.analysis_type !== tableDatasets[tableActive].analysis_type) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (i === tableActive ? ' active' : '');
      b.innerHTML = `<span class="swatch" style="background:${H.color(i)}"></span><span class="tab-name">${escapeHtml(d.name)}</span>`;
      b.title = 'Click to edit · double-click to rename';
      b.addEventListener('click', () => { tableSwitch(i); });
      b.addEventListener('dblclick', async () => {
        const name = await H.requestName(tableDatasets[i].name);
        if (name !== null) { tableDatasets[i].name = name.trim() || tableDatasets[i].name; renderTabs(); }
      });
      box.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tab add';
    add.textContent = H.addLabel || 'New';
    add.addEventListener('click', addNewOfType);
    box.appendChild(add);
  }

  /** The "New" tab: add a fresh dataset of the currently selected type. */
  async function addNewOfType() {
    const type = tableDatasets[tableActive].analysis_type || 'xy';
    const suggested = defaultName();
    let name = suggested;
    if (H.newName) { name = await H.newName(suggested); if (name === null) return; }
    if (readCurrentEntry() === false) return;
    if (tableDatasets[tableActive].analysis_type === 'multivariate') unmountMultivariate();
    tableDatasets.push(H.newDataset((name || '').trim() || suggested, type));
    tableActive = tableDatasets.length - 1;
    render();
  }

  function tableSwitch(i) {
    if (i === tableActive) return;
    if (readGridToDataset() === false) return;
    tableActive = i;
    renderTabs(); renderGrid();
  }

  async function tableRemoveDataset(i) {
    if (!tableDatasets[i].analysis_type) return;
    const n = i === tableActive && tableDatasets[i].analysis_type === 'xy'
      ? [...$('grid').querySelectorAll('tbody tr')].filter((tr) => [...tr.querySelectorAll('input')].some((input) => input.value.trim())).length
      : tokens(tableDatasets[i].x).length;
    if (n > 0 && !await H.confirmDelete(tableDatasets[i].name, n)) return;
    if (i !== tableActive && readGridToDataset() === false) return;
    const type = tableDatasets[i].analysis_type;
    tableDeleted = true;
    tableDatasets.splice(i, 1);
    if (!tableDatasets.length) tableDatasets = [H.newDataset('Dataset 1', '')];
    tableActive = Math.min(tableActive > i ? tableActive - 1 : tableActive, tableDatasets.length - 1);
    const sameType = tableDatasets.findIndex((d) => d.analysis_type === type);
    if (sameType >= 0) tableActive = sameType;
    renderTabs(); renderGrid();
  }

  function tableDuplicateDataset() {
    if (readGridToDataset() === false) return;
    tableActive = duplicateDatasetInto(tableDatasets, tableActive);
    renderTabs();
    renderGrid();
  }

  /** Add a fresh dataset from within the dialog (the "New plot" tab). Returns
   *  false if the current grid does not validate, so the caller can keep its
   *  type chooser open. */
  function addTableDataset(type, name) {
    if (!tableDatasets) return false;
    if (readGridToDataset() === false) return false;
    if (!tableDatasets[tableActive].analysis_type) tableDatasets.splice(tableActive, 1);
    tableDatasets.push(H.newDataset(name || `Dataset ${tableDatasets.length + 1}`, type));
    tableActive = tableDatasets.length - 1;
    renderTabs();
    renderGrid();
    return true;
  }

  // ---------------------------------------------------------------- grid

  /** Fill the XY grid from the active table dataset (renderEntry controls visibility). */
  function renderGrid(extraRows = 3) {
    const d = tableDatasets[tableActive];
    const histNote = $('table-histogram-note'); if (histNote) histNote.hidden = true;
    const cols = GRID_COLS.map((c) => tableColumnCells(d[c]));
    const n = Math.max(MIN_ROWS, Math.max(...cols.map((c) => c.length)) + extraRows);
    const tbody = $('grid').querySelector('tbody');
    const frag = document.createDocumentFragment();
    for (let r = 0; r < n; r++) frag.appendChild(gridRow(r, cols.map((c) => c[r] ?? '')));
    tbody.innerHTML = '';
    tbody.appendChild(frag);
    renderedGridSnapshot = gridSnapshot();
    updateTableCount();
  }

  function gridSnapshot() {
    return JSON.stringify([...$('grid').querySelectorAll('tbody tr')]
      .map((tr) => [...tr.querySelectorAll('input')].map((input) => input.value.trim()))
      .filter((row) => row.some((value) => value !== '')));
  }

  function tableColumnCells(text) {
    return String(text || '').trimEnd().split(/\r?\n/).flatMap((line) => line.trim() ? tokens(line) : ['']);
  }

  function gridRow(r, values) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="rownum">${r + 1}</td>` +
      values.map((v, c) => `<td><input type="text" inputmode="decimal" spellcheck="false" aria-label="Row ${r + 1}, ${['X', 'Y', 'Y uncertainty', 'X uncertainty'][c]}" data-r="${r}" data-c="${c}" value="${escapeHtml(v)}"></td>`).join('') +
      `<td class="rowdel"><button type="button" class="rowdel-btn" aria-label="Delete row ${r + 1}" title="Delete this row">×</button></td>`;
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
      tr.querySelector('.rowdel-btn').setAttribute('aria-label', `Delete row ${r + 1}`);
      tr.querySelectorAll('input').forEach((inp, c) => { inp.dataset.r = r; inp.setAttribute('aria-label', `Row ${r + 1}, ${['X', 'Y', 'Y uncertainty', 'X uncertainty'][c]}`); });
    });
  }

  /** The grid -> the active table dataset (as column text). Incomplete X/Y rows remain in the editor until corrected; one uncertainty value applies to every point; incomplete uncertainty columns remain editable. */
  function readGridToDataset() {
    if (fitEnabled()) readTableFit();
    if (tableDatasets[tableActive].derivedFrom) {
      if (gridSnapshot() !== renderedGridSnapshot) { $('table-count').textContent = 'Calculated values are linked to Analyze Data. Edit their sources or expression there.'; return false; }
      return true;
    }
    if (tableDatasets[tableActive].analysis_type !== 'xy') return;
    const rows = [...$('grid').querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value.trim()));
    const incomplete = rows.findIndex((r) => r.some((v) => v !== '') && (r[0] === '' || r[1] === ''));
    if (incomplete >= 0) {
      $('table-count').textContent = `Row ${incomplete + 1}: enter both X and Y, or delete the row. No rows have been discarded.`;
      gridInput(incomplete, rows[incomplete][0] === '' ? 0 : 1)?.focus();
      return false;
    }
    const kept = rows.filter((r) => r[0] !== '' && r[1] !== '');
    for (const c of [2, 3]) {
      const count = kept.filter((r) => r[c] !== '').length;
      if (count > 1 && count < kept.length) {
        $('table-count').textContent = `${c === 2 ? 'Y' : 'X'} uncertainty: enter one value for the axis, one per point, or leave the column empty. Missing uncertainties have not been set to zero.`;
        return false;
      }
    }
    const d = tableDatasets[tableActive];
    GRID_COLS.forEach((col, c) => {
      if (c < 2) { d[col] = kept.map((r) => r[c]).join('\n'); return; }
      const filled = kept.filter((r) => r[c] !== '');
      if (filled.length === 1) { d[col] = filled[0][c]; return; }
      d[col] = filled.length ? kept.map((r) => r[c] === '' ? '0' : r[c]).join('\n') : '';
    });
    return { total: rows.filter((r) => r.some((v) => v !== '')).length, kept: kept.length };
  }

  function updateTableCount() {
    const rows = [...$('grid').querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('input')].map((i) => i.value.trim()));
    const filled = rows.filter((r) => r.some((v) => v !== '')).length;
    const kept = rows.filter((r) => r[0] !== '' && r[1] !== '').length;
    const bad = rows.flat().filter((v) => v !== '' && !Number.isFinite(Number(v))).length;
    let text = `${kept} point${kept === 1 ? '' : 's'}`;
    if (filled > kept) text += ` · ${filled - kept} row${filled - kept === 1 ? '' : 's'} missing X or Y`;
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
    const rows = lines.map(splitTableRow);
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

  // ---------------------------------------------------------------- import from text

  /** Explicit delimiters preserve empty cells so uncertainty columns cannot shift. */
  function splitTableRow(line) {
    const separator = line.includes('\t') ? '\t' : line.includes(',') ? ',' : line.includes(';') ? ';' : null;
    return separator ? line.split(separator).map((cell) => cell.trim()) : line.trim().split(/\s+/);
  }
  function importRows() {
    return $('import-text').value.split(/\r?\n/).filter((line) => line.trim() !== '').map(splitTableRow);
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
    if (tableDatasets[tableActive]?.derivedFrom) { msg('info', 'Calculated data is linked to Analyze Data. Paste into a new dataset instead.'); return; }
    const rows = importRows();
    if (!rows.length) return;
    const mapping = [...$('import-mapping').querySelectorAll('select')].map((s) => s.value);
    const d = tableDatasets[tableActive];
    const out = { x: [], y: [], ex: [], ey: [] };
    rows.forEach((r, i) => {
      mapping.forEach((target, c) => { if (target) out[target].push(r[c] ?? ''); });
      if (!mapping.includes('x')) out.x.push(String(i + 1));
    });
    for (const c of GRID_COLS) d[c] = out[c].join('\n');
    $('import-panel').hidden = true;
    renderGrid();
  }

  // ---------------------------------------------------------------- per-dataset fit settings

  function readTableFit() {
    if (!tableDatasets) return;
    const previous = tableDatasets[tableActive].fit;
    const fit = Object.fromEntries(Object.keys(defaultFitSettings()).map((key) => [key, $('table-fit-' + key).value]));
    if (previous?.equation && previous.equation.formula === fit.formula) fit.equation = JSON.parse(JSON.stringify(previous.equation));
    tableDatasets[tableActive].fit = fit;
  }
  function writeTableFit() {
    const d = tableDatasets[tableActive];
    const settings = normalizeFitSettings(d.fit);
    $('table-fit-label').textContent = 'Fit settings for ' + d.name;
    for (const key of Object.keys(defaultFitSettings())) $('table-fit-' + key).value = settings[key];
  }

  // ---------------------------------------------------------------- histogram (in-dialog)

  function buildHistogramForm() {
    if (histBuilt) return;
    const box = $('insert-histogram');
    if (!box) return;
    box.innerHTML =
      '<div class="ins-hist-field"><label for="ins-hist-source">Histogram input</label>' +
      '<select id="ins-hist-source"><option value="samples">Individual measurements</option><option value="counts">Pre-binned counts</option></select></div>' +
      '<div class="ins-hist-field" data-hgroup="samples"><label for="ins-hist-samples">Measurements</label>' +
      '<textarea id="ins-hist-samples" rows="6" spellcheck="false" placeholder="One measurement per line"></textarea></div>' +
      '<div class="ins-hist-field" data-hgroup="counts" hidden><label for="ins-hist-counts">Bin counts</label>' +
      '<textarea id="ins-hist-counts" rows="6" spellcheck="false" placeholder="One nonnegative whole count per bin"></textarea></div>' +
      '<div class="ins-hist-row" data-hgroup="samples">' +
      '<div class="ins-hist-field"><label for="ins-hist-bins">Number of bins</label><input id="ins-hist-bins" type="number" min="1" max="2000" placeholder="Automatic"></div>' +
      '<div class="ins-hist-field"><label for="ins-hist-min">Range from</label><input id="ins-hist-min" type="text" placeholder="Automatic"></div>' +
      '<div class="ins-hist-field"><label for="ins-hist-max">to</label><input id="ins-hist-max" type="text" placeholder="Automatic"></div></div>' +
      '<div class="ins-hist-field"><label for="ins-hist-edges">Bin edges <span class="hint-inline">optional for measurements; required for counts, in increasing order</span></label>' +
      '<textarea id="ins-hist-edges" rows="2" spellcheck="false" placeholder="0, 1, 2, 4, 8"></textarea></div>' +
      '<p class="hint">The plot shows counts per unit X. Choose Done, then Fit (or Plot histogram) to build it.</p>';
    for (const id of Object.keys(HIST_MAP)) {
      const el = $(id);
      el.addEventListener('input', readHistogram);
      if (id === 'ins-hist-source') el.addEventListener('change', () => { readHistogram(); renderHistogram(); });
    }
    histBuilt = true;
  }

  function renderHistogram() {
    buildHistogramForm();
    const d = tableDatasets[tableActive];
    const h = d.histogram || (d.histogram = defaultHistogram());
    for (const [id, key] of Object.entries(HIST_MAP)) { const el = $(id); if (el) el.value = h[key] ?? ''; }
    const counts = h.source === 'counts';
    for (const g of $('insert-histogram').querySelectorAll('[data-hgroup]')) g.hidden = (g.dataset.hgroup === 'counts') !== counts;
  }

  function readHistogram() {
    const d = tableDatasets[tableActive];
    const h = d.histogram || (d.histogram = defaultHistogram());
    for (const [id, key] of Object.entries(HIST_MAP)) { const el = $(id); if (el) h[key] = el.value; }
  }

  // ---------------------------------------------------------------- multivariate (portal)
  // Reuse the panel's multivariate editor by relocating it into the dialog and
  // pointing window.Multivariate at the working-copy dataset. Restored on close.

  function mountMultivariate() {
    const data = $('multivariate-data'), model = $('multivariate-model'), target = $('insert-multivariate');
    if (!target) return;
    if (!data || !model || !window.Multivariate) { target.innerHTML = '<p class="hint">The multivariate editor is unavailable here.</p>'; return; }
    if (!mvMounted) {
      mvHomes = { data: [data.parentNode, data.nextSibling], model: [model.parentNode, model.nextSibling] };
      target.appendChild(data);
      target.appendChild(model);
      mvMounted = true;
    }
    data.hidden = false; model.hidden = false;
    window.Multivariate.load(tableDatasets[tableActive]);
  }

  function unmountMultivariate() {
    if (!mvMounted) return;
    const data = $('multivariate-data'), model = $('multivariate-model');
    if (mvHomes && data && model) {
      mvHomes.data[0].insertBefore(data, mvHomes.data[1]);
      mvHomes.model[0].insertBefore(model, mvHomes.model[1]);
      data.hidden = true; model.hidden = true;
    }
    mvMounted = false;
  }

  // ---------------------------------------------------------------- actions + wiring

  const TABLE_ACTIONS = {
    'duplicate': tableDuplicateDataset,
    'add-rows': () => { appendGridRows(10); updateTableCount(); },
    'delete-empty': tableDeleteEmpty,
    'delete': () => tableRemoveDataset(tableActive),
    'import': () => { $('import-panel').hidden = false; renderImportMapping(); $('import-text').focus(); },
    'import-apply': importApply,
    'import-cancel': () => { $('import-panel').hidden = true; },
    'done': tableDone,
    'cancel': tableCancel,
  };

  /** Wire the dialog's events once, the first time a host opens it. */
  function ensureWired() {
    if (wired) return;
    const dialog = $('table-dialog');
    if (!dialog) return;
    if ($('table-fit-formula')) {
      for (const key of Object.keys(defaultFitSettings())) {
        const el = $('table-fit-' + key);
        if (el) el.addEventListener('input', () => { if (fitEnabled()) readTableFit(); });
      }
    }
    const grid = $('grid');
    if (grid) {
      grid.addEventListener('paste', gridPaste);
      grid.addEventListener('keydown', gridKeydown);
      grid.addEventListener('input', updateTableCount);
      grid.addEventListener('click', (ev) => { if (ev.target.classList.contains('rowdel-btn')) gridDeleteRow(ev.target); });
    }
    for (const el of dialog.querySelectorAll('[data-taction]')) {
      const fn = TABLE_ACTIONS[el.dataset.taction];
      if (fn) el.addEventListener('click', fn);
    }
    const importText = $('import-text');
    if (importText) importText.addEventListener('input', renderImportMapping);
    dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); tableCancel(); });   // Escape = cancel
    wired = true;
  }

  /** True while the dialog is open with edits not yet committed to the host. */
  function hasPendingEdits() {
    if (!tableDatasets || !H) return false;
    if (JSON.stringify(tableDatasets) !== JSON.stringify(H.datasets())) return true;
    return tableDatasets[tableActive]?.analysis_type === 'xy' && gridSnapshot() !== renderedGridSnapshot;
  }

  window.InsertData = { open, addTableDataset, hasPendingEdits };
})();
