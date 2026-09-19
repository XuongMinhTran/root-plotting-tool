// Run with: node tests/plot_expand_test.cjs
// Loads app.js into a vm sandbox (same approach as plot_sizing_test.cjs) and
// exercises the "Expand plot" toggle: it grows the plot downward, wins over a
// backend-supplied height while expanded, and restores the normal height when
// collapsed, keeping the button's label and pressed state in step.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const plot = { style: {}, clientHeight: 600, closest: () => ({ scrollIntoView() {} }), querySelector: () => null };
const btn = {
  attrs: {},
  textContent: '',
  title: '',
  setAttribute(k, v) { this.attrs[k] = v; },
  getAttribute(k) { return this.attrs[k]; },
};
const context = vm.createContext({
  console,
  window: { addEventListener() {}, innerHeight: 900 },
  document: {
    getElementById: (id) => (id === 'plot' ? plot : id === 'plot-expand' ? btn : {}),
    dispatchEvent() {}, querySelectorAll() { return []; },
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

// expand -> grows downward (0.88 * 900 = 792), button reflects the pressed state
run('toggleExpandPlot()');
assert.equal(plot.style.height, '792px', 'expand should grow the plot downward');
assert.equal(btn.getAttribute('aria-pressed'), 'true');
assert.equal(btn.textContent, 'Collapse plot');

// while expanded, a backend-supplied plot_height must NOT shrink it back
run('applyPlotHeight({plot_height:456})');
assert.equal(plot.style.height, '792px', 'expanded mode wins over a backend height');

// collapse -> no stored/back-end height means the CSS default (cleared inline)
run('toggleExpandPlot()');
assert.equal(plot.style.height, '', 'collapse should clear the inline height');
assert.equal(btn.getAttribute('aria-pressed'), 'false');
assert.equal(btn.textContent, 'Expand plot');

// collapsed, a backend height is honoured again
run('applyPlotHeight({plot_height:456})');
assert.equal(plot.style.height, '456px', 'collapsed mode honours the backend height');

// the expanded height has a sensible floor on short windows
run('window.innerHeight = 400; toggleExpandPlot()');
assert.equal(plot.style.height, '700px', 'expanded height floors at 700px on short windows');

console.log('OK: expand toggle grows downward, wins over backend height, collapses, and floors.');
