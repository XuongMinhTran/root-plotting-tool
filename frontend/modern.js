/* modern.js — the parts of the Modern workspace that are Modern's own.
 *
 * All the real work (parsing columns, talking to the backend, drawing, saving)
 * lives in the shared app.js. This file only handles presentation:
 *
 *   1. turning the hidden preset <select> into a row of clickable shapes
 *   2. the step chips: click to scroll, and a highlight that follows the page
 *   3. the one-line summaries under each step ("8 points", "Gaussian peak")
 *   4. the "More" menu, and moving the reader to the result after a fit
 *
 * app.js announces what it has done with three events on `document`:
 * rootfit:draw, rootfit:reset and rootfit:message.
 */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const STEPS = ['data', 'function', 'options'];
  const DIAGNOSTICS = ['residual', 'pull', 'ratio', 'percent', 'histogram'];

  // ---------------------------------------------------------------- presets
  // The <select> is the control app.js listens to; these buttons are a
  // friendlier face for it, so a student picks a shape instead of reading a
  // dropdown. app.js fills that list itself and swaps it when the analysis
  // type changes, so the buttons are rebuilt whenever its options change.
  // Each option reads "Straight line  [0]*x+[1]" — name, two spaces, formula.
  function buildPresets() {
    const select = $('quick-pick');
    const box = $('presets');
    if (!select || !box || !select.options) return;
    if (box.replaceChildren) box.replaceChildren(); else box.innerHTML = '';
    let shown = 0;
    for (const option of [...select.options]) {
      if (!option.value) continue;
      const formula = option.value.split('|')[0];
      const parts = String(option.textContent).split(/\s{2,}|\|/);
      const name = (parts[0] || formula).trim();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.dataset.formula = formula;
      button.setAttribute('aria-pressed', 'false');
      const label = document.createElement('b');
      label.textContent = name;
      const code = document.createElement('code');
      code.textContent = (parts[1] || formula).trim();
      button.append(label, code);
      button.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        markPreset();
        refresh();
      });
      box.append(button);
      shown += 1;
    }
    const label = $('preset-label');
    if (label) label.hidden = shown === 0;
  }

  /** app.js replaces the whole option list when the analysis type changes. */
  function watchPresets() {
    const select = $('quick-pick');
    if (!select || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => { buildPresets(); markPreset(); refresh(); })
      .observe(select, { childList: true });
  }

  /** Light up the shape that matches what is in the formula box. */
  function markPreset() {
    const current = ($('formula')?.value || '').trim();
    for (const button of document.querySelectorAll('.preset')) {
      button.setAttribute('aria-pressed', String(button.dataset.formula === current));
    }
  }

  // ---------------------------------------------------------------- step chips
  function chipFor(step) { return document.querySelector(`.step-chip[data-target="step-${step}"]`); }

  function highlight(step) {
    for (const name of STEPS) {
      const chip = chipFor(name);
      if (!chip) continue;
      if (name === step) chip.setAttribute('aria-current', 'step');
      else chip.removeAttribute('aria-current');
    }
  }

  function initSteps() {
    for (const name of STEPS) {
      const chip = chipFor(name);
      const card = $('step-' + name);
      if (!chip || !card) continue;
      chip.addEventListener('click', () => {
        highlight(name);
        if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    // Follow the reader down the page: whichever card is nearest the top wins.
    if (typeof IntersectionObserver !== 'function') return;
    const seen = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target.id, entry);
      let best = null;
      for (const entry of seen.values()) {
        if (!entry.isIntersecting) continue;
        if (!best || entry.boundingClientRect.top < best.boundingClientRect.top) best = entry;
      }
      if (best) highlight(best.target.id.replace('step-', ''));
    }, { rootMargin: '-72px 0px -55% 0px', threshold: 0 });
    for (const name of STEPS) {
      const card = $('step-' + name);
      if (card) observer.observe(card);
    }
  }

  // ---------------------------------------------------------------- summaries
  function text(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  /** Read the page as it stands and describe each step in a few words. */
  function refresh() {
    // Nothing is usable until the analysis type is chosen: app.js disables the
    // dataset controls and the Fit button until then, so say so plainly.
    const type = $('analysis-type')?.value || '';
    if (!type) {
      text('state-data', 'Choose a type');
      text('state-function', 'Waiting for data');
      text('state-options', 'Defaults');
      return;
    }
    if (type === 'histogram') {
      const summary = ($('hist-summary')?.textContent || '').trim();
      text('state-data', summary ? summary.replace(/\.$/, '') : 'Histogram');
      histogramSummary();
      return;
    }
    const points = ($('count-x')?.textContent || '0').trim();
    const n = parseInt(points, 10) || 0;
    const dataset = $('dataset-select');
    const several = dataset && dataset.options && dataset.options.length > 1;
    text('state-data', n === 0 ? 'No points yet'
      : `${n} point${n === 1 ? '' : 's'}${several ? ` · ${dataset.options.length} datasets` : ''}`);

    histogramSummary();
  }

  /** The parts of the summary that do not depend on the analysis type. */
  function histogramSummary() {
    const formula = ($('formula')?.value || '').trim();
    const named = document.querySelector('.preset[aria-pressed="true"] b');
    text('state-function', !formula ? 'Not set yet' : (named ? named.textContent : formula));

    const extras = DIAGNOSTICS.filter((kind) => $('diag-' + kind)?.checked).length;
    const titled = ($('graph-title')?.value || '').trim();
    text('state-options', extras ? `${extras} extra plot${extras === 1 ? '' : 's'}`
      : titled ? 'Titles set' : 'Defaults');
    text('diag-tag', extras ? `${extras} selected` : 'none selected');
  }

  /** app.js rewrites these two tables whenever the data or the formula
   *  changes — including when a document or an example is loaded, which fires
   *  no input events. Watching them keeps the summaries honest. */
  function watchForChanges() {
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(() => { markPreset(); refresh(); });
    for (const id of ['dataset-select', 'param-table', 'hist-summary', 'modern-data-summary']) {
      const el = $(id);
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
    }
  }

  // ---------------------------------------------------------------- menu
  function initMenu() {
    const menu = document.querySelector('.utilities');
    if (!menu) return;
    // Capture phase: app.js stops the click bubbling from its own [data-action]
    // buttons, so listening on the way down is the only way to see them.
    menu.addEventListener('click', (event) => {
      if (event.target.closest && event.target.closest('.utility-menu button')) menu.open = false;
    }, true);
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') menu.open = false;
    });
  }

  // ---------------------------------------------------------------- wiring
  buildPresets();
  watchPresets();
  markPreset();
  initSteps();
  initMenu();
  watchForChanges();
  refresh();

  for (const id of ['analysis-type', 'hist-source', 'hist-samples', 'hist-counts', 'hist-edges']) {
    $(id)?.addEventListener('input', refresh);
    $(id)?.addEventListener('change', refresh);
  }

  for (const id of ['formula', 'graph-title', 'col-x', 'col-y']) {
    $(id)?.addEventListener('input', () => { markPreset(); refresh(); });
  }
  for (const kind of DIAGNOSTICS) $('diag-' + kind)?.addEventListener('change', refresh);

  // A finished fit: keep the plot in view. On a wide screen the rail is
  // already beside the form, so nothing needs to move.
  document.addEventListener('rootfit:draw', () => {
    refresh();
    const narrow = typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 1100;
    const rail = $('results');
    if (narrow && rail && rail.scrollIntoView) rail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (typeof replotToSize === 'function') replotToSize(); });
    }
  });

  document.addEventListener('rootfit:reset', () => {
    markPreset();
    refresh();
    highlight('data');
  });

  // An error or a warning is worth looking at, wherever the reader is.
  document.addEventListener('rootfit:message', (event) => {
    const kind = event.detail && event.detail.kind;
    if (kind !== 'error' && kind !== 'warn') return;
    const box = $('message');
    if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  if (typeof hideHelp === 'function') document.addEventListener('scroll', () => hideHelp(), { passive: true });
})();
