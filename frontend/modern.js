/* Section navigation for Modern. All calculations and document handling stay in app.js. */
'use strict';
(() => {
  const tabs = [...document.querySelectorAll('[data-stage]')];
  let active = 'data';
  function summarizeData() {
    const selected = document.getElementById('dataset-select');
    document.getElementById('modern-data-summary').textContent = selected.selectedOptions[0]?.textContent || 'No data entered yet.';
  }
  function showStage(stage, focus = false) {
    active = stage;
    for (const tab of tabs) {
      const selected = tab.dataset.stage === stage;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    document.getElementById('modern-next').hidden = stage !== 'data';
    document.getElementById('btn-fit').hidden = stage === 'data';
    document.getElementById('btn-fit').textContent = stage === 'results' ? 'Fit again' : 'Fit data';
    const back = document.getElementById('modern-back');
    back.hidden = stage === 'data';
    back.textContent = stage === 'results' ? 'Edit fit settings' : 'Back to data';
    summarizeData();
    if (typeof hideHelp === 'function') hideHelp();
    if (stage === 'results') requestAnimationFrame(() => {
      if (typeof replotToSize === 'function') replotToSize();
    });
    // Retain the document header; return to section navigation after a long form.
    if (focus) document.querySelector('.stage-tabs').scrollIntoView({ block: 'nearest' });
  }
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('click', () => showStage(tab.dataset.stage, true));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); showStage(tabs[next].dataset.stage, true); }
    });
  }
  document.getElementById('modern-next').addEventListener('click', () => showStage('fit', true));
  document.getElementById('modern-back').addEventListener('click', () => showStage(active === 'results' ? 'fit' : 'data', true));
  for (const button of document.querySelectorAll('[data-modern-help]')) {
    button.addEventListener('click', event => { event.stopPropagation(); showHelp(button.dataset.help, button); });
  }
  const menu = document.querySelector('.utilities');
  menu.addEventListener('click', event => { if (event.target.closest('button')) menu.open = false; }, true);
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.open = false; });
  document.addEventListener('rootfit:draw', () => {
    document.getElementById('modern-result-note').textContent = 'The plot and report describe the most recent fit. Return to Data or Fit settings to make adjustments.';
    showStage('results', true);
  });
  document.addEventListener('rootfit:reset', () => {
    document.getElementById('modern-result-note').textContent = 'Run a fit to see the plot and parameter estimates here.';
    showStage('data');
  });
  document.addEventListener('rootfit:message', event => {
    if (event.detail.kind === 'error' || event.detail.kind === 'warn') {
      document.getElementById('message').scrollIntoView({ block: 'nearest' });
    }
  });
  document.addEventListener('DOMContentLoaded', summarizeData);
})();
