// Run: node tests/modern_navigation_test.cjs
// Checks page navigation, result freshness, and shared application events.
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
for (const name of ['data', 'function', 'results']) {
  const chip = make(null, 'step-chip');
  chip.dataset.target = 'step-' + name;
  make('step-' + name, 'card');
}
for (const kind of ['residual', 'pull', 'ratio', 'percent', 'histogram']) {
  make('diag-' + kind, null, { tag: 'input' });
}
make('graph-title', null, { tag: 'input' });
make('results', 'rail');
make('step-options', 'card');
for (const id of ['modern-back','modern-next','btn-fit','state-results']) make(id);
make('message', 'message');
make('result-input-notice');
make('col-x', null, { tag: 'input' });
make('col-y', null, { tag: 'input' });

let replots = 0;
const scrolls = [];
const fixture = {
  document,
  window: { innerWidth: 900, scrollTo(options) { scrolls.push(options); } },                       // narrow: the rail is below the form
  Event: class { constructor(type) { this.type = type; } },
  requestAnimationFrame: (fn) => fn(),
  replotToSize() { replots += 1; },
  lastResult: null, lastPayload: null, readForm: () => ({x:[1]}), buildPayload: x => x,
};
vm.runInNewContext(fs.readFileSync('frontend/modern.js', 'utf8'), fixture);

// Presets use the shared native select; summary resolves its current formula.
assert.equal(select.options.length, 3);
const html = fs.readFileSync('frontend/modern.html', 'utf8');
assert.match(html, /<select id="quick-pick">/);
assert(!html.includes('id="presets"'));

byId.get('formula').value = 'gaus';
// --- 3. step chips scroll and follow ---------------------------------------
const chips = ['data', 'function', 'results'].map((n) => document.querySelector(`.step-chip[data-target="step-${n}"]`));
chips[1].fire('click');
assert.equal(chips[0].attributes['aria-current'], 'step', 'choose an analysis type before opening the model');
byId.get('analysis-type').value = 'xy';
chips[1].fire('click');
assert.equal(chips[0].attributes['aria-current'], 'step', 'enter data before opening the model');
byId.get('col-x').value = '1 2';byId.get('col-y').value = '3 4';
chips[1].fire('click');
assert.equal(chips[1].attributes['aria-current'], 'step');
assert.equal(chips[0].attributes['aria-current'], undefined, 'only one step is current');
assert.equal(scrolls.at(-1).top, 0, 'switching pages starts at the document top');
assert.equal(scrolls.at(-1).behavior, 'instant');
assert.equal(chips[1].scrolled, 0, 'navigation does not scroll the page to the tabs');

// --- 4. what app.js announces ----------------------------------------------
document.fire('rootfit:draw');
assert.ok(replots > 0, 'the plot is told its box may have changed size');
assert.equal(scrolls.at(-1).top, 0, 'results start at the document top');

document.fire('rootfit:reset');
assert.equal(chips[0].attributes['aria-current'], 'step', 'a reset returns to step 1');

document.fire('rootfit:message', { detail: { kind: 'error' } });
assert.equal(byId.get('message').scrolled, 1, 'errors are scrolled into view');
document.fire('rootfit:message', { detail: { kind: 'info' } });
assert.equal(byId.get('message').scrolled, 1, 'ordinary notes do not move the page');

console.log('OK: native preset dropdown and fit/reset/message handling.');

assert.equal(byId.get('step-data').hidden,false);
assert.equal(byId.get('step-function').hidden,true);
assert.equal(byId.get('results').hidden,true);
byId.get('modern-next').fire('click');
assert.equal(byId.get('step-data').hidden,true);
assert.equal(byId.get('step-function').hidden,false);
assert.equal(byId.get('step-options').hidden,false);
assert.equal(byId.get('btn-fit').hidden,false);
document.fire('rootfit:draw');
assert.equal(byId.get('results').hidden,false);
assert.equal(byId.get('step-function').hidden,true);
assert.equal(byId.get('step-options').hidden,true);
byId.get('modern-back').fire('click');
assert.equal(byId.get('step-function').hidden,false);
byId.get('modern-back').fire('click');
assert.equal(byId.get('step-data').hidden,false);
chips[0].fire('keydown',{key:'End'});
assert.equal(byId.get('results').hidden,false);
assert.equal(byId.get('formula').value,'gaus');
console.log('OK: three separate pages, Next/Back, keyboard navigation, result transition, and retained inputs.');

assert.equal(scrolls.at(-1).top, 0, 'keyboard navigation also returns to the top');
assert.ok(scrolls.length >= 8, 'all page transitions reset scroll');

fixture.lastResult = {fit_performed:true};
fixture.lastPayload = {x:[1]};
document.fire('rootfit:draw');
assert.equal(byId.get('result-input-notice').hidden,true);
fixture.readForm = () => ({x:[2]});
document.fire('input');
assert.equal(byId.get('result-input-notice').hidden,false);
fixture.readForm = () => ({x:[1]});
document.fire('change');
assert.equal(byId.get('result-input-notice').hidden,true);
console.log('OK: result notice distinguishes current inputs from the last fitted inputs.');
