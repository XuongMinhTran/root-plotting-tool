// Run with: node tests/plot_style_test.cjs
// Loads plot-style.js in a vm sandbox and checks styledCanvas() against a
// ROOT-shaped TCanvas (a TGraphErrors with the fit TF1, stats box and title in
// its fFunctions list, a TLegend, grid on by default). Verifies each option
// maps to the right ROOT field and that hidden boxes are dropped — without a
// browser or ROOT.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const store = {};
const context = vm.createContext({
  console, structuredClone,
  window: {},
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
});
vm.runInContext(fs.readFileSync('frontend/plot-style.js', 'utf8'), context);
const PS = context.window.PlotStyle;
assert.equal(typeof PS.styledCanvas, 'function');

// A faithful single-pad fit canvas.
function canvas() {
  return {
    _typename: 'TCanvas', fLogx: 0, fLogy: 0, fGridx: 1, fGridy: 1,
    fPrimitives: {
      _typename: 'TList',
      arr: [
        { _typename: 'TFrame' },
        {
          _typename: 'TGraphErrors', fMarkerColor: 1, fMarkerStyle: 20, fMarkerSize: 1, fLineColor: 1,
          fFunctions: {
            _typename: 'TList',
            arr: [
              { _typename: 'TF1', fLineColor: 2, fLineWidth: 2, fLineStyle: 1 },
              { _typename: 'TPaveStats', fName: 'stats' },
              { _typename: 'TPaveText', fName: 'title' },
            ],
            opt: ['', '', ''],
          },
        },
        { _typename: 'TLegend' },
      ],
      opt: ['', 'ap', ''],
    },
  };
}
const graphOf = (c) => c.fPrimitives.arr.find((p) => p._typename === 'TGraphErrors');
const funcsOf = (c) => graphOf(c).fFunctions.arr;

// --- axes / grid map to the pad fields
let c = PS.styledCanvas(canvas(), { logx: true, logy: true, gridx: false, gridy: false });
assert.equal(c.fLogx, 1); assert.equal(c.fLogy, 1);
assert.equal(c.fGridx, 0); assert.equal(c.fGridy, 0);

// --- input is never mutated
const base = canvas();
PS.styledCanvas(base, { logx: true, stats: false });
assert.equal(base.fLogx, 0, 'styledCanvas must not mutate its input');
assert.equal(funcsOf(base).some((f) => f._typename === 'TPaveStats'), true, 'input stats box must survive');

// --- marker styling hits the data graph only
c = PS.styledCanvas(canvas(), { markerColor: 632, markerStyle: 21, markerSize: 1.3 });
const g = graphOf(c);
assert.equal(g.fMarkerColor, 632); assert.equal(g.fMarkerStyle, 21); assert.equal(g.fMarkerSize, 1.3);

// --- line styling hits the fit function
c = PS.styledCanvas(canvas(), { lineColor: 600, lineWidth: 3, lineStyle: 2 });
const f = funcsOf(c).find((x) => x._typename === 'TF1');
assert.equal(f.fLineColor, 600); assert.equal(f.fLineWidth, 3); assert.equal(f.fLineStyle, 2);

// --- hiding boxes drops them (and keeps opt parallel)
c = PS.styledCanvas(canvas(), { stats: false, title: false, legend: false });
assert.equal(funcsOf(c).some((x) => x._typename === 'TPaveStats'), false, 'stats box should be gone');
assert.equal(funcsOf(c).some((x) => x._typename === 'TPaveText'), false, 'title should be gone');
assert.equal(c.fPrimitives.arr.some((x) => x._typename === 'TLegend'), false, 'legend should be gone');
assert.equal(c.fPrimitives.arr.length, c.fPrimitives.opt.length, 'arr/opt must stay the same length');
assert.equal(funcsOf(c).length, graphOf(c).fFunctions.opt.length, 'fFunctions arr/opt must stay parallel');

// --- defaults change nothing (round-trips the same boxes)
c = PS.styledCanvas(canvas(), {});
assert.equal(funcsOf(c).some((x) => x._typename === 'TPaveStats'), true);
assert.equal(c.fPrimitives.arr.some((x) => x._typename === 'TLegend'), true);

// --- readAxes reflects the drawn state (JSON round-trip avoids cross-realm identity)
assert.deepEqual(JSON.parse(JSON.stringify(PS.readAxes(canvas()))), { logx: false, logy: false, gridx: true, gridy: true });

console.log('OK: plot-style maps every option to the right ROOT field, hides boxes, and never mutates its input.');
