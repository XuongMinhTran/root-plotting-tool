// Run: node tests/modern_navigation_test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(id) { this.id = id; this.handlers = {}; this.attributes = {}; this.dataset = {}; this.hidden = false; }
  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  fire(name, detail = {}) { for (const fn of this.handlers[name] || []) fn({preventDefault(){}, stopPropagation(){}, ...detail}); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  contains() { return false; }
}
const ids = new Map();
const get = id => { if (!ids.has(id)) ids.set(id, new Element(id)); return ids.get(id); };
const tabs = ['data', 'fit', 'results'].map(stage => {
  const tab = get(`tab-${stage}`); tab.dataset.stage = stage; tab.attributes['aria-controls'] = `panel-${stage}`; return tab;
});
get('dataset-select').selectedOptions = [{textContent:'Test dataset (3 points)'}];
const doc = new Element('document');
doc.getElementById = get;
doc.querySelectorAll = selector => selector === '[data-stage]' ? tabs : [];
doc.querySelector = get;
let resizeCount = 0;
vm.runInNewContext(fs.readFileSync('frontend/modern.js', 'utf8'), {document:doc, requestAnimationFrame:fn=>fn(), hideHelp(){}, replotToSize(){resizeCount++;}});
get('modern-next').fire('click');
assert.equal(get('panel-fit').hidden, false);
assert.equal(get('panel-data').hidden, true);
assert.equal(get('btn-fit').hidden, false);
assert.equal(get('modern-data-summary').textContent, 'Test dataset (3 points)');
tabs[1].fire('keydown', {key:'ArrowRight'});
assert.equal(get('panel-results').hidden, false);
assert.equal(tabs[2].attributes['aria-selected'], 'true');
assert.equal(tabs[2].focused, true);
assert.ok(resizeCount > 0);
doc.fire('rootfit:reset');
assert.equal(get('panel-data').hidden, false);
assert.equal(get('btn-fit').hidden, true);
doc.fire('rootfit:draw');
assert.equal(get('panel-results').hidden, false);
assert.equal(get('btn-fit').textContent, 'Fit again');
get('modern-back').fire('click');
assert.equal(get('panel-fit').hidden, false);
get('modern-back').fire('click');
assert.equal(get('panel-data').hidden, false);
console.log('OK: section navigation, keyboard access, result display, reset, and return to editing.');
