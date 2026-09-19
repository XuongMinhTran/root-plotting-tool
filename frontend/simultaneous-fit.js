/* Simultaneous fits: two or more XY datasets fitted together with shared parameters.
 *
 * Loaded by both interfaces after app.js and uses its shared globals
 * (datasets, simultaneousFits, callBackend, renderReport, autosave, …).
 * The group data model is documented in workspace-store.js:
 *   {id, name, members:[{datasetId, parameters:[{role:'shared', shared:'tau'} |
 *    {role:'local'} | {role:'fixed', value:'9.81'}]}], shared:[{name, guess, min, max}], result?}
 * Local initial guesses are the member dataset's own initial guesses, so a
 * value typed here is the same value the dataset's fit settings show.
 */
(() => {
'use strict';
const el = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S = window.WorkspaceStore;
const ROLE_LABELS = {local:'This dataset only', shared:'Shared', fixed:'Fixed value'};
let dlg = null, group = null;   // the open dialog and the group being edited

const byId = id => datasets.find(d => d.id === id);
const xyDatasets = () => datasets.filter(d => d.analysis_type === 'xy');
const guesses = d => splitList(d.fit?.initial_guesses);
function paramNames(d) {
  const names = splitList(d.fit?.param_names);
  return Array.from({length: countParams(d.fit?.formula || '')}, (_, j) => names[j] || 'p' + j);
}
function setGuess(d, j, value) {
  const list = guesses(d);
  while (list.length <= j) list.push('');
  list[j] = String(value).trim();
  let k = list.length;
  while (k > 0 && list[k - 1] === '') k--;
  d.fit.initial_guesses = list.slice(0, k).join(', ');
  if (d === datasets[activeIdx]) { el('initial-guesses').value = d.fit.initial_guesses; renderParamTable(); }
}
/** Keep a member's role list aligned with its dataset's current model. */
function syncMember(m) {
  const d = byId(m.datasetId);
  const n = d ? countParams(d.fit?.formula || '') : 0;
  if (m.parameters.length > n) m.parameters.length = n;
  while (m.parameters.length < n) m.parameters.push({role:'local'});
}
function uniqueName(base) {
  const taken = new Set(group.shared.map(s => s.name));
  let name = base || 'shared', k = 2;
  while (taken.has(name)) name = (base || 'shared') + k++;
  return name;
}
function newGroup() {
  const taken = new Set(simultaneousFits.map(g => g.name));
  let k = simultaneousFits.length + 1, name;
  do { name = 'Simultaneous fit ' + k++; } while (taken.has(name));
  return {id: S.id(), name, members: [], shared: []};
}
function sortMembers() {
  group.members.sort((a, b) => datasets.findIndex(d => d.id === a.datasetId) - datasets.findIndex(d => d.id === b.datasetId));
}
/** A shared parameter for a model parameter called `name`: reuse a same-named one or create it. */
function assignShared(name, guess) {
  const existing = group.shared.find(s => s.name === name);
  if (existing) return existing.name;
  const created = {name: uniqueName(name), guess: String(guess ?? '').trim(), min: '', max: ''};
  group.shared.push(created);
  return created.name;
}
function usedBy(name) {
  return group.members.filter(m => m.parameters.some(p => p.role === 'shared' && p.shared === name)).map(m => byId(m.datasetId)?.name || '?');
}
/** Save the edited group into the session (a group needs two members to exist). */
function commit() {
  if (!group) return;
  const i = simultaneousFits.findIndex(g => g.id === group.id);
  if (group.members.length >= 2) { if (i < 0) simultaneousFits.push(group); }
  else if (i >= 0) simultaneousFits.splice(i, 1);
  refresh();
  autosave();
}

function refresh() {
  const button = el('simultaneous-fit');
  if (!button) return;
  pruneSimultaneousFits();
  button.disabled = xyDatasets().length < 2;
  button.textContent = 'Fit together' + (simultaneousFits.length ? ' (' + simultaneousFits.length + ')' : '') + '…';
  button.title = button.disabled ? 'Add at least two XY datasets to fit them together.' : 'Fit two or more datasets at once, with parameters shared between them.';
}

// ---------------------------------------------------------------- payload

/** The JSON body for POST /simultaneous-fit. Throws an Error with a readable message. */
function buildPayload(g) {
  const inputs = readForm();
  const o = inputs.options || {};
  if (g.members.length < 2) throw new Error('Choose at least two datasets to fit together.');
  const sharedIndex = new Map();
  const shared = g.shared.map((s, k) => {
    const name = String(s.name || '').trim();
    if (!name) throw new Error('Every shared parameter needs a name.');
    if (sharedIndex.has(name)) throw new Error(`Shared parameter names must be unique ("${name}" appears twice).`);
    sharedIndex.set(name, k);
    const numbers = {};
    for (const [key, label] of [['guess', 'initial guess'], ['min', 'lower limit'], ['max', 'upper limit']]) {
      numbers[key] = numberOrNull(s[key]);
      if (Number.isNaN(numbers[key])) throw new Error(`Shared parameter ${name}: the ${label} must be a number or blank.`);
    }
    if (numbers.min !== null && numbers.max !== null && !(numbers.min < numbers.max)) throw new Error(`Shared parameter ${name}: the lower limit must be smaller than the upper limit.`);
    if (numbers.guess !== null && ((numbers.min !== null && numbers.guess < numbers.min) || (numbers.max !== null && numbers.guess > numbers.max))) throw new Error(`Shared parameter ${name}: the initial guess must lie within its limits.`);
    return {name, ...numbers};
  });
  const members = [], mapping = [], used = new Set();
  for (const m of g.members) {
    const d = byId(m.datasetId);
    if (!d) throw new Error('One of the chosen datasets no longer exists. Reopen the dialog.');
    if (d.analysis_type !== 'xy') throw new Error(`${d.name} is not an XY dataset.`);
    if (d.calculationError) throw new Error(`${d.name}: ${d.calculationError}`);
    const cols = {};
    for (const c of COLUMNS) {
      const {values, bad} = parseColumn(d[c]);
      if (bad.length) throw new Error(`${d.name}, ${COLUMN_LABEL[c]}: "${bad[0]}" is not a number${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}.`);
      cols[c] = values;
    }
    if (cols.x.length < 2 || cols.y.length < 2) throw new Error(`${d.name}: enter at least two X and Y values before fitting.`);
    if (cols.x.length !== cols.y.length) throw new Error(`${d.name}: X has ${cols.x.length} points but Y has ${cols.y.length}. Each point needs an X and a Y value.`);
    for (const c of ['ex', 'ey']) {
      if (cols[c].some(v => v < 0)) throw new Error(`${d.name}: ${COLUMN_LABEL[c]} describe a size, so use zero or a positive number.`);
      if (cols[c].length === 1) cols[c] = Array(cols.x.length).fill(cols[c][0]);
      else if (cols[c].length && cols[c].length !== cols.x.length) throw new Error(`${d.name}: ${COLUMN_LABEL[c]}: ${cols[c].length} values for ${cols.x.length} points. Enter one value for the whole axis, ${cols.x.length} values for individual points, or leave it blank.`);
    }
    const excluded = (d.exclusions || []).filter(p => cols.x[p.index] === p.x && cols.y[p.index] === p.y);
    if (excluded.length !== (d.exclusions || []).length) throw new Error(`${d.name}: some excluded measurements have changed position or value. Review its Point exclusions and apply them again before fitting.`);
    const omit = new Set(excluded.map(p => p.index));
    for (const c of COLUMNS) cols[c] = cols[c].filter((_, i) => !omit.has(i));
    if (cols.x.length < 2) throw new Error(`${d.name}: include at least two measurements before fitting. Review its Point exclusions.`);
    const formula = String(d.fit?.formula || '').trim();
    if (!formula) throw new Error(`${d.name}: choose a fit function in its fit settings first.`);
    syncMember(m);
    const names = paramNames(d), starts = guesses(d);
    if (!names.length) throw new Error(`${d.name}: no parameters were found in its fit function ${formula}.`);
    const xmin = numberOrNull(d.fit.x_min), xmax = numberOrNull(d.fit.x_max);
    if (Number.isNaN(xmin) || Number.isNaN(xmax)) throw new Error(`${d.name}: each fit-range limit must be a number or blank.`);
    let x_range = null;
    if (xmin !== null || xmax !== null) {
      const lo = xmin === null ? Math.min(...cols.x) : xmin;
      const hi = xmax === null ? Math.max(...cols.x) : xmax;
      if (!(lo < hi)) throw new Error(`${d.name}: fit range "from" (${lo}) must be smaller than "to" (${hi}).`);
      const inside = cols.x.filter(v => v >= lo && v <= hi).length;
      if (inside < 2) throw new Error(`${d.name}: only ${inside} point(s) fall inside its fit range [${lo}, ${hi}].`);
      x_range = [lo, hi];
    }
    mapping.push(m.parameters.map((p, j) => {
      const label = `${d.name}, parameter ${names[j]}`;
      if (p.role === 'shared') {
        if (!sharedIndex.has(p.shared)) throw new Error(`${label}: the shared parameter "${p.shared || ''}" does not exist. Choose one in the parameter table.`);
        used.add(p.shared);
        return {kind: 'shared', ref: sharedIndex.get(p.shared)};
      }
      if (p.role === 'fixed') {
        const value = numberOrNull(p.value);
        if (value === null || Number.isNaN(value)) throw new Error(`${label}: enter the value it is fixed at.`);
        return {kind: 'fixed', value};
      }
      const guess = numberOrNull(starts[j] ?? '');
      if (Number.isNaN(guess)) throw new Error(`${label}: the initial guess "${starts[j]}" is not a number.`);
      return {kind: 'local', guess};
    }));
    members.push({name: d.name, x: cols.x, y: cols.y, ex: cols.ex, ey: cols.ey, formula, param_names: names, x_range, excluded_points: excluded});
  }
  for (const s of shared) if (!used.has(s.name)) throw new Error(`Shared parameter ${s.name} is not used by any dataset. Assign it in the parameter table, or remove it.`);
  return {
    name: g.name, datasets: members, parameters: {shared, mapping},
    title: inputs.graph_title, x_title: inputs.x_title, y_title: inputs.y_title,
    plot: {logx: !!o.logx, logy: !!o.logy, grid: o.grid !== false, diagnostics: diagnosticPayload(o)},
  };
}

// ---------------------------------------------------------------- dialog

function open(groupId) {
  syncActiveFromColumns();
  pruneSimultaneousFits();
  if (xyDatasets().length < 2) {
    askDialog({title: 'Two datasets needed', message: 'Create at least two XY datasets before fitting them together: use New plot or Paste data… in the dataset row.', cancel: null});
    return;
  }
  if (dlg) dlg.close();
  group = simultaneousFits.find(g => g.id === (groupId || viewingGroup)) || (simultaneousFits.length ? simultaneousFits[simultaneousFits.length - 1] : newGroup());
  dlg = document.createElement('dialog');
  dlg.className = 'tframe feature-dialog simfit-dialog';
  dlg.setAttribute('aria-labelledby', 'simfit-title');
  dlg.innerHTML = `<form novalidate>
    <h2 id="simfit-title">Fit datasets together</h2>
    <p>Choose two or more XY datasets and decide, for every parameter of every model, whether it is <strong>shared</strong> (one value fitted to all datasets that use it), belongs to <strong>this dataset only</strong>, or is a <strong>fixed value</strong> that is not fitted. Each dataset keeps its own fit function, fit range, initial guesses and point exclusions. <a href="documentation.html#simultaneous-fits" target="_blank" rel="noopener">Help with shared fits</a></p>
    <div class="simfit-toolbar">
      <label>Simultaneous fit<select data-group aria-label="Which simultaneous fit to edit"></select></label>
      <label>Name<input data-name aria-label="Name of this simultaneous fit" maxlength="120"></label>
      <button type="button" data-show>Show last result</button>
      <button type="button" data-delete class="danger">Delete</button>
    </div>
    <p class="simfit-status" data-status aria-live="polite"></p>
    <div data-body></div>
    <p data-error role="alert"></p>
    <div class="row actions"><button type="button" data-cancel>Close</button><button type="submit" class="primary">Fit together</button></div>
    <p class="hint">Axis titles, log axes, the grid and the optional diagnostic plots follow the plot settings of the page. Confidence bands are not available for simultaneous fits. ROOT's automatic starting values for named functions such as <code>gaus</code> are not used here, so enter initial guesses.</p>
  </form>`;
  dlg.addEventListener('change', onChange);
  dlg.addEventListener('input', onInput);
  dlg.addEventListener('click', onClick);
  dlg.querySelector('form').addEventListener('submit', event => { event.preventDefault(); runGroupFit(); });
  const dialog = dlg;   // 'close' fires asynchronously; only tidy up if this is still the open dialog
  dialog.addEventListener('close', () => { if (dlg === dialog) { commit(); dlg = null; group = null; } dialog.remove(); });
  document.body.append(dlg);
  load(group);
  dlg.showModal();
}

function load(g) {
  group = g;
  for (const m of group.members) syncMember(m);
  sortMembers();
  render();
}

function render() {
  if (!dlg || !group) return;
  const active = document.activeElement;
  const focusKey = active && dlg.contains(active) ? [...active.attributes].find(a => a.name.startsWith('data-')) : null;
  const select = dlg.querySelector('[data-group]');
  const listed = simultaneousFits.some(g => g.id === group.id);
  select.innerHTML = simultaneousFits.map(g => `<option value="${escape(g.id)}" ${g.id === group.id ? 'selected' : ''}>${escape(g.name)}${g.result ? ' (fitted)' : ''}</option>`).join('')
    + `<option value="" ${listed ? '' : 'selected'}>New simultaneous fit…</option>`;
  dlg.querySelector('[data-name]').value = group.name;
  const r = group.result?.response;
  const stale = r && group.result.sourceSignature !== S.groupSignature(group, datasets);
  dlg.querySelector('[data-status]').textContent = r
    ? (stale ? 'A result is stored, but the data, models, ranges or parameter roles changed since. Fit again to update it.'
             : `Stored result: χ² ${fmtNum(r.chi2)} for NDF ${r.ndf}${r.converged ? '' : ' — did not converge'}.`)
    : (group.members.length >= 2 ? 'Not fitted yet.' : 'Choose at least two datasets.');
  dlg.querySelector('[data-show]').disabled = !r;
  dlg.querySelector('[data-delete]').disabled = !listed;
  const memberOf = id => group.members.find(m => m.datasetId === id);

  const datasetRows = xyDatasets().map(d => {
    const n = parseColumn(d.x).values.length, k = d.exclusions?.length || 0;
    const range = d.fit?.x_min || d.fit?.x_max ? `, range [${escape(d.fit.x_min || 'min')}, ${escape(d.fit.x_max || 'max')}]` : '';
    return `<label><input type="checkbox" data-member="${escape(d.id)}" ${memberOf(d.id) ? 'checked' : ''}><strong>${escape(d.name)}</strong> — <code>${escape(d.fit?.formula || '(no fit function)')}</code> (${n} points${k ? `, ${k} excluded` : ''}${range})</label>`;
  }).join('');

  const paramRows = group.members.map((m, mi) => {
    const d = byId(m.datasetId);
    const names = paramNames(d), starts = guesses(d);
    if (!names.length) return `<tr><td><strong>${escape(d.name)}</strong></td><td colspan="3" class="fine">No parameters were found in its fit function <code>${escape(d.fit?.formula || '')}</code>. Choose a model in its fit settings.</td></tr>`;
    return m.parameters.map((p, j) => {
      const who = `${escape(names[j])} of ${escape(d.name)}`;
      const sharedSelect = p.role !== 'shared' ? '' : ` <select data-shared="${mi}:${j}" aria-label="Shared parameter used by ${who}">${group.shared.map(s => `<option value="${escape(s.name)}" ${s.name === p.shared ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}<option value="__new__">New shared parameter…</option></select>`;
      const value = p.role === 'shared'
        ? `<span class="fine">from shared parameter ${escape(p.shared)}</span>`
        : `<input data-value="${mi}:${j}" inputmode="decimal" value="${escape(p.role === 'fixed' ? (p.value ?? '') : (starts[j] ?? ''))}" placeholder="${p.role === 'fixed' ? 'Fixed value' : 'Default'}" aria-label="${p.role === 'fixed' ? 'Fixed value' : 'Initial guess'} of ${who}">`;
      return `<tr class="role-${p.role}"><td>${j === 0 ? '<strong>' + escape(d.name) + '</strong>' : ''}</td><td><code>[${j}]</code> ${escape(names[j])}</td><td><select data-role="${mi}:${j}" aria-label="Role of ${who}">${['local', 'shared', 'fixed'].map(role => `<option value="${role}" ${p.role === role ? 'selected' : ''}>${ROLE_LABELS[role]}</option>`).join('')}</select>${sharedSelect}</td><td>${value}</td></tr>`;
    }).join('');
  }).join('');

  const sharedRows = group.shared.map((s, k) => `<tr>
    <td><input data-sname="${k}" value="${escape(s.name)}" aria-label="Name of shared parameter ${k + 1}" maxlength="40"></td>
    <td><input data-sguess="${k}" inputmode="decimal" value="${escape(s.guess)}" placeholder="Default" aria-label="Initial guess of ${escape(s.name)}"></td>
    <td><input data-smin="${k}" inputmode="decimal" value="${escape(s.min)}" placeholder="None" aria-label="Lower limit of ${escape(s.name)}"></td>
    <td><input data-smax="${k}" inputmode="decimal" value="${escape(s.max)}" placeholder="None" aria-label="Upper limit of ${escape(s.name)}"></td>
    <td class="fine">${usedBy(s.name).map(escape).join(', ') || '<span class="simfit-unused">not used yet</span>'}</td>
    <td><button type="button" data-sremove="${k}" aria-label="Remove shared parameter ${escape(s.name)}">Remove</button></td></tr>`).join('');

  dlg.querySelector('[data-body]').innerHTML = `
    <fieldset><legend>Datasets</legend><div class="simfit-datasets">${datasetRows}</div></fieldset>
    <fieldset><legend>Parameters</legend>
      ${group.members.length ? `<div class="feature-table"><table><thead><tr><th>Dataset</th><th>Parameter</th><th>Role</th><th>Start value</th></tr></thead><tbody>${paramRows}</tbody></table></div>` : '<p class="hint">Choose datasets above to assign their parameters.</p>'}
      <p class="hint">Start values of parameters marked “This dataset only” are the initial guesses of that dataset; editing them here updates its fit settings. A fixed value is held constant and reported without an uncertainty.</p>
    </fieldset>
    <fieldset><legend>Shared parameters</legend>
      ${group.shared.length ? `<div class="feature-table simfit-shared"><table><thead><tr><th>Name</th><th>Initial guess</th><th>Lower limit</th><th>Upper limit</th><th>Used by</th><th></th></tr></thead><tbody>${sharedRows}</tbody></table></div>` : '<p class="hint">No shared parameters yet. Set the role of a parameter to Shared, or add one here and assign it in the table above.</p>'}
      <button type="button" data-sadd>Add shared parameter</button>
      <p class="hint">Limits are optional. A shared parameter has one value, one initial guess and one uncertainty for all datasets that use it.</p>
    </fieldset>`;
  if (focusKey) dlg.querySelector(`[${focusKey.name}="${CSS.escape(focusKey.value)}"]`)?.focus();
}

function coords(text) { return text.split(':').map(Number); }

function onChange(event) {
  const t = event.target, data = t.dataset;
  if (t.matches('[data-group]')) { const g = simultaneousFits.find(x => x.id === t.value); commit(); load(g || newGroup()); return; }
  if (t.matches('[data-name]')) { group.name = t.value.trim() || 'Simultaneous fit'; commit(); render(); return; }
  if (data.member !== undefined) {
    if (t.checked) { if (!group.members.some(m => m.datasetId === data.member)) { const m = {datasetId: data.member, parameters: []}; syncMember(m); group.members.push(m); } }
    else group.members = group.members.filter(m => m.datasetId !== data.member);
    sortMembers(); commit(); render(); return;
  }
  if (data.role) {
    const [mi, j] = coords(data.role), m = group.members[mi], d = byId(m.datasetId), p = m.parameters[j], next = {role: t.value};
    if (t.value === 'shared') next.shared = assignShared(paramNames(d)[j], guesses(d)[j]);
    if (t.value === 'fixed') next.value = p.role === 'fixed' ? p.value : (guesses(d)[j] ?? '');
    m.parameters[j] = next; commit(); render(); return;
  }
  if (data.shared) {
    const [mi, j] = coords(data.shared), m = group.members[mi], d = byId(m.datasetId), p = m.parameters[j];
    if (t.value === '__new__') { const created = {name: uniqueName(paramNames(d)[j]), guess: String(guesses(d)[j] ?? '').trim(), min: '', max: ''}; group.shared.push(created); p.shared = created.name; }
    else p.shared = t.value;
    commit(); render(); return;
  }
  if (data.sname !== undefined) {
    const k = Number(data.sname), s = group.shared[k], name = t.value.trim();
    if (!name) { render(); return; }
    if (group.shared.some((x, i) => i !== k && x.name === name)) { dlg.querySelector('[data-error]').textContent = 'Shared parameter names must be unique.'; render(); return; }
    const old = s.name; s.name = name;
    for (const m of group.members) for (const p of m.parameters) if (p.role === 'shared' && p.shared === old) p.shared = name;
    commit(); render();
  }
}

function onInput(event) {
  const t = event.target, data = t.dataset;
  dlg.querySelector('[data-error]').textContent = '';
  if (data.value) {
    const [mi, j] = coords(data.value), m = group.members[mi], p = m.parameters[j];
    if (p.role === 'fixed') p.value = t.value.trim(); else setGuess(byId(m.datasetId), j, t.value);
    autosave(); return;
  }
  for (const [key, field] of [['sguess', 'guess'], ['smin', 'min'], ['smax', 'max']]) {
    if (data[key] !== undefined) { group.shared[Number(data[key])][field] = t.value.trim(); autosave(); return; }
  }
}

async function onClick(event) {
  const t = event.target.closest('button');
  if (!t || !dlg.contains(t)) return;
  const data = t.dataset;
  if (data.cancel !== undefined) { dlg.close(); return; }
  if (data.sadd !== undefined) { group.shared.push({name: uniqueName('shared'), guess: '', min: '', max: ''}); commit(); render(); dlg.querySelector(`[data-sname="${group.shared.length - 1}"]`)?.focus(); return; }
  if (data.sremove !== undefined) {
    const removed = group.shared.splice(Number(data.sremove), 1)[0];
    for (const m of group.members) m.parameters = m.parameters.map(p => p.role === 'shared' && p.shared === removed.name ? {role: 'local'} : p);
    commit(); render(); return;
  }
  if (data.show !== undefined) {
    const stale = group.result && group.result.sourceSignature !== S.groupSignature(group, datasets);
    const g = group; dlg.close(); showSimultaneousResult(g);
    if (stale) showMessage('warn', 'This stored result predates changes to the data, models, ranges or parameter roles. Fit again to update it.');
    return;
  }
  if (data.delete !== undefined) {
    const confirmed = await askDialog({title: 'Delete simultaneous fit', message: `Delete “${group.name}” and its stored result? The datasets and their own fits are kept.`, accept: 'Delete', destructive: true});
    if (!confirmed || !dlg) return;
    const id = group.id;
    simultaneousFits = simultaneousFits.filter(g => g.id !== id);
    if (viewingGroup === id) showDatasetResult();
    group = newGroup(); refresh(); autosave(); load(group);
  }
}

async function runGroupFit() {
  const error = dlg.querySelector('[data-error]'), submit = dlg.querySelector('[type=submit]');
  error.textContent = '';
  let payload;
  try { payload = buildPayload(group); } catch (e) { error.textContent = e.message; return; }
  submit.disabled = true; submit.textContent = 'Fitting…';
  setStatus(el('fit-status'), 'Fitting ' + group.name, 'busy');
  const g = group;
  try {
    const result = await callBackend('/simultaneous-fit', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)}, 120000);
    g.result = {response: result, payload, sourceSignature: S.groupSignature(g, datasets)};
    if (!simultaneousFits.some(x => x.id === g.id)) simultaneousFits.push(g);
    if (dlg) dlg.close();
    showSimultaneousResult(g);
    autosave();
    const notes = result.plot_notes?.length ? result.plot_notes.join('\n') : '';
    if (!result.converged) showMessage('warn', `Fit did not converge. ${result.status_message} Check initial guesses, parameter identifiability, and the fit ranges before interpreting the result.` + (notes ? '\n' + notes : ''));
    else if (notes) showMessage('info', notes);
    setStatus(el('fit-status'), result.converged ? 'Fit done — ' + g.name : 'Fit not converged', result.converged ? 'ok' : 'warn');
  } catch (e) {
    if (dlg) { error.textContent = e.message; submit.disabled = false; submit.textContent = 'Fit together'; }
    else showMessage('error', e.message);
    setStatus(el('fit-status'), 'Fit not completed', 'err');
  }
}

// ---------------------------------------------------------------- wiring

function init() {
  const anchor = el('point-exclusions') || document.querySelector('[data-paste-spreadsheet]');
  if (!anchor) return;
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'simultaneous-fit'; button.textContent = 'Fit together…';
  button.onclick = () => open();
  anchor.after(button);
  refresh();
}
window.SimultaneousFit = {open, refresh, buildPayload, syncMember};
init();
})();
