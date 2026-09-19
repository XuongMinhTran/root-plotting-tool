// Run with: node tests/plot_expand_test.cjs
// Loads app.js into a vm sandbox (same approach as plot_sizing_test.cjs) and
// exercises the "Expand plot" toggle. It now puts the plot's frame into
// full-screen (a .plot-fullscreen overlay owns the size, so the inline height is
// cleared), and collapsing restores the normal / backend / dragged height. The
// button's label and pressed state track the state.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const classes = new Set();
const frame = {
  classList: {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    contains: (c) => classes.has(c),
  },
};
const plot = { style: {}, clientHeight: 600, closest: () => frame, querySelector: () => null };
const btn = {
  attrs: {}, textContent: '', title: '',
  setAttribute(k, v) { this.attrs[k] = v; },
  getAttribute(k) { return this.attrs[k]; },
};
const context = vm.createContext({
  console,
  window: { addEventListener() {}, innerHeight: 900 },
  document: {
    body: { style: {} },
    getElementById: (id) => (id === 'plot' ? plot : id === 'plot-expand' ? btn : { style: { removeProperty() {}, setProperty() {} } }),
    dispatchEvent() {}, addEventListener() {}, querySelectorAll() { return []; },
    createElement: () => ({ style: {}, dataset: {} }),
  },
  CustomEvent: class {},
});
vm.runInContext(fs.readFileSync('frontend/app.js', 'utf8').replace(/\ninit\(\);\s*$/, ''), context);
vm.runInContext('loadLayout=()=>({});', context);
const run = (expr) => vm.runInContext(expr, context);

// starts collapsed after the init sync
run('syncExpandButton()');
assert.equal(btn.getAttribute('aria-pressed'), 'false');
assert.equal(btn.textContent, 'Expand plot');
assert.equal(classes.has('plot-fullscreen'), false);

// expand -> full-screen overlay class on, inline height cleared, button pressed
run('toggleExpandPlot()');
assert.equal(classes.has('plot-fullscreen'), true, 'expand should add the full-screen overlay class');
assert.equal(plot.style.height, '', 'full-screen lets the CSS overlay own the height');
assert.equal(btn.getAttribute('aria-pressed'), 'true');
assert.equal(btn.textContent, 'Collapse plot');

// while full-screen, a backend plot_height must not set an inline height
run('applyPlotHeight({plot_height:456})');
assert.equal(plot.style.height, '', 'full-screen ignores a backend height');

// collapse -> overlay class removed, back to the CSS default (no inline height)
run('toggleExpandPlot()');
assert.equal(classes.has('plot-fullscreen'), false, 'collapse should remove the overlay class');
assert.equal(plot.style.height, '', 'collapse clears the inline height');
assert.equal(btn.getAttribute('aria-pressed'), 'false');
assert.equal(btn.textContent, 'Expand plot');

// collapsed, a backend height is honoured again
run('applyPlotHeight({plot_height:456})');
assert.equal(plot.style.height, '456px', 'collapsed mode honours the backend height');

// reset also leaves full-screen
run('toggleExpandPlot()');
assert.equal(classes.has('plot-fullscreen'), true);
run('resetLayout()');
assert.equal(classes.has('plot-fullscreen'), false, 'resetLayout must exit full-screen');
assert.equal(btn.getAttribute('aria-pressed'), 'false');

console.log('OK: Expand toggles a full-screen overlay, ignores backend height while up, and restores on collapse/reset.');
