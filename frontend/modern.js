/* modern.js — the parts of the Modern workspace that are Modern's own.
 *
 * All the real work (parsing columns, talking to the backend, drawing, saving)
 * lives in the shared app.js. This file only handles presentation:
 *
 * Page navigation and display of results and messages.
 *
 * app.js announces what it has done with three events on `document`:
 * rootfit:draw, rootfit:reset and rootfit:message.
 */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const STEPS = ['data', 'function', 'results'];
  let activeStep = 'data';

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

  function showStep(step, focus = false) {
    if (step === 'function') {
      const type = $('analysis-type').value;
      const hasNumbers = id => /[0-9]/.test($(id)?.value || '');
      const hasData = type === 'xy' ? hasNumbers('col-x') && hasNumbers('col-y')
        : type === 'histogram' ? hasNumbers($('hist-source').value === 'counts' ? 'hist-counts' : 'hist-samples') : false;
      if (!hasData) {
        step = 'data';
        if (typeof askDialog === 'function') askDialog({title:'Enter data first',
          message:'Add measurement data before selecting a fit model. For XY data, enter both X and Y values; for a histogram, enter measurements or bin counts.',
          accept:'Enter data', cancel:null});
      }
    }
    activeStep = step;
    $('step-data').hidden = step !== 'data';
    $('step-function').hidden = step !== 'function';
    $('step-options').hidden = step !== 'function';
    $('results').hidden = step !== 'results';
    $('modern-next').hidden = step !== 'data';
    $('modern-back').hidden = step === 'data';
    $('modern-back').textContent = step === 'results' ? 'Edit fit model' : 'Back to measurements';
    $('btn-fit').hidden = step !== 'function';
    highlight(step);
    updateResultNotice();
    if (focus) chipFor(step)?.focus?.({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (step === 'results' && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (typeof replotToSize === 'function') replotToSize(); });
    }
  }
  function initSteps() {
    STEPS.forEach((name, index) => {
      const chip = chipFor(name);
      if (!chip) return;
      chip.setAttribute('aria-controls', name === 'results' ? 'results' : 'step-' + name);
      chip.addEventListener('click', () => showStep(name, true));
      chip.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % STEPS.length;
        if (event.key === 'ArrowLeft') next = (index + STEPS.length - 1) % STEPS.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = STEPS.length - 1;
        if (next !== undefined) { event.preventDefault(); showStep(STEPS[next], true); }
      });
    });
    $('modern-next').addEventListener('click', () => showStep('function', true));
    $('modern-back').addEventListener('click', () => showStep(activeStep === 'results' ? 'function' : 'data', true));
    showStep('data');
  }

  function updateResultNotice() {
    const notice = $('result-input-notice');
    if (!notice) return;
    if (typeof lastResult === 'undefined' || !lastResult || !lastPayload) { notice.hidden = true; return; }
    if (lastResult.analysis_type === 'simultaneous') { notice.hidden = true; return; }   // the Fit together dialog reports staleness itself
    try {
      notice.hidden = JSON.stringify(buildPayload(readForm(), lastResult.fit_performed !== false)) === JSON.stringify(lastPayload);
    } catch (_) {
      notice.hidden = false;
    }
  }

  // ---------------------------------------------------------------- wiring
  initSteps();
  document.addEventListener('input', updateResultNotice);
  document.addEventListener('change', updateResultNotice);
  document.addEventListener('rootfit:draw', () => {
    showStep('results', true);
  });

  document.addEventListener('rootfit:reset', () => {
    showStep('data');
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
