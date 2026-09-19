// Run with: node tests/multivariate_frontend_test.cjs
// Exercises the multivariate module's payload building and validation without a
// browser, the same way frontend_test.cjs loads a frontend file into a vm
// sandbox and reads values back across the realm boundary as JSON.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const context = vm.createContext({
  console,
  window: {},
  document: {
    readyState: 'complete',
    addEventListener() {},
    getElementById: (id) => (id === 'graph-title' ? { value: '' } : null),
  },
});
vm.runInContext(fs.readFileSync('frontend/multivariate.js', 'utf8'), context);
const read = (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context));

assert.equal(read('typeof window.Multivariate.buildPayload'), 'function');

// A base R^2 -> R dataset (5 points) available inside the sandbox.
vm.runInContext(`
  globalThis.base = () => ({ name:'T', analysis_type:'multivariate', mv:{
    n:2, m:1, inNames:['x0','x1'],
    inVals:['1\\n2\\n3\\n4\\n5','0\\n1\\n0\\n1\\n2'], inErr:['',''],
    outNames:['y'], outVals:['2\\n5\\n4\\n7\\n10'], outErr:['0.1'],
    models:['[0]*x0 + [1]*x1 + [2]'], parNames:'a, b, c', parGuesses:'1, 1, 0' } });
  globalThis.M = window.Multivariate;
  globalThis.p = M.buildPayload(base());
`, context);

// --- a well-formed request maps to the backend contract exactly
assert.equal(read('p.n_inputs'), 2);
assert.equal(read('p.n_outputs'), 1);
assert.deepEqual(read('p.inputs[0]'), [1, 2, 3, 4, 5]);
assert.deepEqual(read('p.inputs[1]'), [0, 1, 0, 1, 2]);
assert.deepEqual(read('p.outputs[0]'), [2, 5, 4, 7, 10]);
assert.deepEqual(read('p.output_errors[0]'), [0.1]);   // one value = whole column
assert.deepEqual(read('p.input_errors'), [[], []]);    // blank stays blank
assert.deepEqual(read('p.models'), ['[0]*x0 + [1]*x1 + [2]']);
assert.deepEqual(read('p.param_names'), ['a', 'b', 'c']);
assert.deepEqual(read('p.initial_guesses'), ['1', '1', '0']);
assert.deepEqual(read('p.input_names'), ['x0', 'x1']);
assert.deepEqual(read('p.output_names'), ['y']);
assert.equal(read('p.analysis_type'), 'multivariate');

// --- shared parameter across two outputs (R^1 -> R^2) and a full error column
vm.runInContext(`
  globalThis.ps = M.buildPayload({ name:'S', analysis_type:'multivariate', mv:{
    n:1, m:2, inNames:['x0'], inVals:['1\\n2\\n3\\n4'], inErr:[''],
    outNames:['u','v'], outVals:['2\\n4\\n6\\n8','5\\n6\\n7\\n8'],
    outErr:['0.1\\n0.1\\n0.1\\n0.1',''],
    models:['[0]*x0','[0]*x0 + [1]'], parNames:'a, b', parGuesses:'1, 1' } });
`, context);
assert.deepEqual(read('ps.output_errors[0]'), [0.1, 0.1, 0.1, 0.1]);  // per-row column kept
assert.equal(read('ps.n_outputs'), 2);

// --- validation failures speak plainly
const throwsIn = (expr, re) => assert.throws(() => vm.runInContext(expr, context), re);
throwsIn("M.buildPayload({...base(), mv:{...base().mv, outVals:['2\\n5']}})", /rows/);
throwsIn("(()=>{const d=base(); d.mv.inVals[0]='1\\nx\\n3\\n4\\n5'; return M.buildPayload(d);})()", /not a number/);
throwsIn("(()=>{const d=base(); d.mv.outErr=['0.1\\n0.2']; return M.buildPayload(d);})()", /Enter one value/);
throwsIn("(()=>{const d=base(); d.mv.models=['']; return M.buildPayload(d);})()", /Enter a model/);
throwsIn(`M.buildPayload({ name:'tiny', mv:{ n:1,m:1, inNames:['x0'], inVals:['1\\n2'], inErr:[''],
  outNames:['y'], outVals:['1\\n2'], outErr:[''], models:['[0]*x0 + [1]'], parNames:'', parGuesses:'' } })`, /more data/);

// label helper reflects the shape
assert.match(read('M.label(base())'), /R.*→R.*\(5 points\)/);

console.log('OK: multivariate payload contract, shared parameters, error columns, and validation.');
