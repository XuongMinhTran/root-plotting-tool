// Run: node tests/modern_navigation_test.cjs
// Checks Modern's own presentation layer: preset shapes built from the hidden
// <select>, the step summaries, the step highlight, and what happens when
// app.js announces a fit, a reset or a message.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.handlers = {};
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.parent = null;
    this.scrolled = 0;
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  dispatchEvent(event) { this.fire(event.type, event); return true; }
  fire(name, detail = {}) {
    for (const fn of this.handlers[name] || []) {
      fn({ type: name, preventDefault() {}, stopPropagation() {}, target: this, ...detail });
    }
  }
  scrollIntoView() { this.scrolled += 1; }
  closest(sel) { return sel === '.utility-menu button' ? null : null; }
  contains() { return false; }
  querySelectorAll(sel) { return document.querySelectorAll(sel, this); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
}

const byId = new Map();
const registry = [];                       // everything with a class, for selectors
function make(id, cls, extra = {}) {
  const el = new Element(extra.tag || 'div');
  el.id = id;
  if (cls) el.className = cls;
  Object.assign(el, extra);
  if (id) byId.set(id, el);
  registry.push(el);
  return el;
}

const document = new Element('document');
document.getElementById = (id) => byId.get(id) || null;
document.createElement = (tag) => { const el = new Element(tag); registry.push(el); return el; };
document.querySelectorAll = (sel, scope) => {
  const all = registry.filter((el) => !scope || el === scope || el.parent === scope || el.parent?.parent === scope);
  if (sel === '.preset') return all.filter((el) => el.className === 'preset');
  if (sel === '.utilities') return all.filter((el) => el.className === 'utilities');
  if (sel === '.utility-menu button') return [];
  if (sel === '.preset[aria-pressed="true"] b') {
    const chip = all.find((el) => el.className === 'preset' && el.attributes['aria-pressed'] === 'true');
    return chip ? chip.children.filter((c) => c.tagName === 'B') : [];
  }
  if (sel === 'tbody tr') return (scope?.rows) || [];
  const step = /^\.step-chip\[data-target="([^"]+)"\]$/.exec(sel);
  if (step) return all.filter((el) => el.className === 'step-chip' && el.dataset.target === step[1]);
  return [];
};
document.querySelector = (sel) => document.querySelectorAll(sel)[0] || null;

// --- the pieces of modern.html that modern.js reaches for -------------------
const select = make('quick-pick', null, { tag: 'select' });
const PRESETS = [
  ['[0]*x+[1]|slope, intercept|1, 0', 'Straight line  [0]*x+[1]'],
  ['pol2|a, b, c|', 'Quadratic  pol2'],
  ['gaus|constant, mean, sigma|', 'Gaussian peak  gaus'],
];
for (const [value, label] of PRESETS) {
  const option = new Element('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}
make('presets');
make('preset-label');
make('analysis-type', null, { tag: 'select', value: '' });
make('hist-summary');
make('formula', null, { tag: 'input', value: '[0]*x+[1]' });
make('count-x', null, { textContent: '8' });
const datasets = make('dataset-select', null, { tag: 'select' });
datasets.append(new Element('option'));
const paramTable = make('param-table');
paramTable.rows = [new Element('tr'), new Element('tr')];
for (const id of ['state-data', 'state-function', 'state-options', 'diag-tag']) make(id);
for (const name of ['data', 'function', 'options']) {
  const chip = make(null, 'step-chip');
  chip.dataset.target = 'step-' + name;
  make('step-' + name, 'card');
}
for (const kind of ['residual', 'pull', 'ratio', 'percent', 'histogram']) {
  make('diag-' + kind, null, { tag: 'input' });
}
make('graph-title', null, { tag: 'input' });
make('results', 'rail');
make('message', 'message');
make('col-x', null, { tag: 'input' });
make('col-y', null, { tag: 'input' });

let replots = 0;
vm.runInNewContext(fs.readFileSync('frontend/modern.js', 'utf8'), {
  document,
  window: { innerWidth: 900 },                       // narrow: the rail is below the form
  Event: class { constructor(type) { this.type = type; } },
  requestAnimationFrame: (fn) => fn(),
  replotToSize() { replots += 1; },
});

// --- 1. the hidden select becomes clickable shapes --------------------------
const presets = document.querySelectorAll('.preset');
assert.equal(presets.length, 3, 'one button per preset');
assert.equal(presets[0].children[0].textContent, 'Straight line');
assert.equal(presets[0].children[1].textContent, '[0]*x+[1]');
assert.equal(presets[0].attributes['aria-pressed'], 'true', 'the current formula is marked');
assert.equal(presets[1].attributes['aria-pressed'], 'false');

let changes = 0;
select.addEventListener('change', () => { changes += 1; });
presets[2].fire('click');
assert.equal(select.value, 'gaus|constant, mean, sigma|', 'clicking a shape drives the real control');
assert.equal(changes, 1, 'app.js is notified through a change event');

// --- 2. the step summaries describe the worksheet ---------------------------
// Nothing is usable until an analysis type is chosen, and the chips say so.
assert.equal(byId.get('state-data').textContent, 'Choose a type');
assert.equal(byId.get('state-function').textContent, 'Waiting for data');

byId.get('analysis-type').value = 'xy';
byId.get('analysis-type').fire('change');
assert.equal(byId.get('state-data').textContent, '8 points');
assert.equal(byId.get('state-function').textContent, 'Straight line');
assert.equal(byId.get('state-options').textContent, 'Defaults');

// A histogram counts measurements, not XY points.
byId.get('analysis-type').value = 'histogram';
byId.get('hist-summary').textContent = '200 measurements entered.';
byId.get('analysis-type').fire('change');
assert.equal(byId.get('state-data').textContent, '200 measurements entered');
byId.get('analysis-type').value = 'xy';
byId.get('analysis-type').fire('change');

byId.get('diag-residual').checked = true;
byId.get('diag-pull').checked = true;
byId.get('diag-pull').fire('change');
assert.equal(byId.get('state-options').textContent, '2 extra plots');
assert.equal(byId.get('diag-tag').textContent, '2 selected');

datasets.append(new Element('option'));
byId.get('count-x').textContent = '12';
byId.get('formula').value = 'gaus';
byId.get('formula').fire('input');
assert.equal(byId.get('state-data').textContent, '12 points · 2 datasets');
assert.equal(byId.get('state-function').textContent, 'Gaussian peak');

// --- 3. step chips scroll and follow ---------------------------------------
const chips = ['data', 'function', 'options'].map((n) => document.querySelector(`.step-chip[data-target="step-${n}"]`));
chips[1].fire('click');
assert.equal(chips[1].attributes['aria-current'], 'step');
assert.equal(chips[0].attributes['aria-current'], undefined, 'only one step is current');
assert.equal(byId.get('step-function').scrolled, 1, 'the card is scrolled to');

// --- 4. what app.js announces ----------------------------------------------
document.fire('rootfit:draw');
assert.ok(replots > 0, 'the plot is told its box may have changed size');
assert.equal(byId.get('results').scrolled, 1, 'on a narrow screen the result is brought into view');

document.fire('rootfit:reset');
assert.equal(chips[0].attributes['aria-current'], 'step', 'a reset returns to step 1');

document.fire('rootfit:message', { detail: { kind: 'error' } });
assert.equal(byId.get('message').scrolled, 1, 'errors are scrolled into view');
document.fire('rootfit:message', { detail: { kind: 'info' } });
assert.equal(byId.get('message').scrolled, 1, 'ordinary notes do not move the page');

console.log('OK: preset shapes, step summaries, step highlight, and fit/reset/message handling.');
