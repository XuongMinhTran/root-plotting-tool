// Run with: node tests/frontend_test.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, window: {addEventListener() {}} });
const source = fs.readFileSync('frontend/app.js', 'utf8').replace(/\ninit\(\);\s*$/, '');
vm.runInContext(source, context);
vm.runInContext(`
  globalThis.input = {
    data: {x:'0 1 2', y:'10 5 2.5', ex:'0.1', ey:'0.2'},
    formula:'[0]*exp(-x/[1])', param_names:'', initial_guesses:''
  };
  globalThis.payload = buildPayload(input);
`, context);
const read = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context));
assert.deepEqual(read('payload.ex'), [0.1, 0.1, 0.1]);
assert.deepEqual(read('payload.ey'), [0.2, 0.2, 0.2]);
assert.equal(read('payload.plot.residuals'), 'none');
assert.equal(read("residualSummary({residuals:{kind:'none',values:[1,2]}})"), '');
assert.equal(read('decayStartingGuesses(input)'), '10, 1.443');
assert.throws(() => vm.runInContext("buildPayload({...input,data:{...input.data,ex:'0.1 0.2'}})", context), /one value for the whole axis/);
assert.throws(() => vm.runInContext("buildPayload({...input,data:{...input.data,ey:'-1'}})", context), /zero or a positive/);
for (const kind of ['none', 'residual', 'pull']) {
  assert.equal(read(`buildPayload({...input,options:{residuals:'${kind}'}}).plot.residuals`), kind);
}
// Opening and saving the expanded table must preserve a shared error value.
context.document = {getElementById: () => ({querySelectorAll: () => [
  ['0','10','0.2','0.1'], ['1','5','',''], ['2','2.5','','']
].map(row => ({querySelectorAll: () => row.map(value => ({value}))}))})};
vm.runInContext("tableDatasets = [{analysis_type:'xy',x:'',y:'',ex:'',ey:''}]; tableActive = 0; readGridToDataset();", context);
assert.equal(read('tableDatasets[0].ex'), '0.1');
assert.equal(read('tableDatasets[0].ey'), '0.2');
console.log('OK: shared errors, validation, table round-trip, decay estimates, optional diagnostics.');
// Legacy documents migrate to independent selections; an explicit empty list wins.
assert.deepEqual(read("selectedDiagnostics({residuals:'pull'})"), ['pull']);
assert.deepEqual(read("selectedDiagnostics({residuals:'pull', diagnostics:[]})"), []);
assert.deepEqual(read("diagnosticPayload({diagnostics:['residual','pull','ratio','percent','histogram']}).map(p=>p.kind)"), ['residual','pull','ratio','percent','histogram']);
assert.equal(read("diagnosticPayload({diagnostics:['ratio'],diagnostic_settings:{ratio:{title:'Comparison',y_min:0,y_max:2,height:300}}})[0].y_min"), 0);
assert.throws(() => vm.runInContext("diagnosticPayload({diagnostics:['ratio'],diagnostic_settings:{ratio:{y_min:2,y_max:1}}})", context), /lower Y limit/);
assert.throws(() => vm.runInContext("diagnosticPayload({diagnostics:['histogram'],diagnostic_settings:{histogram:{bins:101}}})", context), /whole number/);
// Saved configuration returns to the controls without losing disabled-plot settings.
const elements = new Map();
const kinds = ['residual','pull','ratio','percent','histogram'];
for (const kind of kinds) {
  elements.set('diag-'+kind, {type:'checkbox',checked:false});
  elements.set('diag-settings-'+kind, {hidden:true});
  for (const key of ['title','x_title','y_title','y_min','y_max','height','bins','scope','grid','reference','errors']) {
    elements.set('diag-'+kind+'-'+key, {type:['grid','reference','errors'].includes(key)?'checkbox':'text',value:'',checked:true});
  }
}
elements.set('diag-empty', {hidden:false});
context.document.getElementById = id => elements.get(id);
vm.runInContext("writeDiagnosticSettings({diagnostics:['residual','histogram'],diagnostic_settings:{residual:{title:'Fit deviations',grid:false},histogram:{bins:23},ratio:{title:'Remember this'}}})", context);
assert.equal(elements.get('diag-residual').checked, true);
assert.equal(elements.get('diag-settings-pull').hidden, true);
assert.equal(read('readDiagnosticSettings().residual.title'), 'Fit deviations');
assert.equal(read('readDiagnosticSettings().residual.grid'), false);
assert.equal(read('readDiagnosticSettings().ratio.title'), 'Remember this');
console.log('OK: multiple selections, legacy migration, advanced validation, and saved diagnostic settings.');
// Older autosaves inherited the original residual default; explicit saved
// selections and manual document loading must remain independent of migration.
vm.runInContext(`
  globalThis.legacyAutosave = {version:1,title:'Keep my data',inputs:{data:{x:'1 2',y:'3 4'},options:{residuals:'residual',grid:false}},results:{params:[]},results_payload:{}};
  globalThis.migratedAutosave = prepareAutosave(legacyAutosave);
`,context);
assert.deepEqual(read('migratedAutosave.inputs.data'),{x:'1 2',y:'3 4'});
assert.equal(read('migratedAutosave.inputs.options.grid'),false);
assert.deepEqual(read('migratedAutosave.inputs.options.diagnostics'),[]);
assert.equal(read('migratedAutosave.results'),null);
assert.equal(read('legacyAutosave.inputs.options.residuals'),'residual');
assert.deepEqual(read("prepareAutosave({inputs:{options:{diagnostics:['residual']}}}).inputs.options.diagnostics"),['residual']);
assert.deepEqual(read('selectedDiagnostics({})'),[]);
vm.runInContext('writeDiagnosticSettings({})',context);
assert.equal(elements.get('diag-residual').checked,false);
console.log('OK: residuals default off; legacy autosave defaults migrate without losing data or explicit modern selections.');

assert.deepEqual(read("splitTableRow('1\t2\t\t0.5')"), ['1','2','','0.5']);
assert.deepEqual(read("splitTableRow('\t2\t0.1\t')"), ['','2','0.1','']);
assert.deepEqual(read("splitTableRow('1,2,,0.5')"), ['1','2','','0.5']);
assert.deepEqual(read("splitTableRow('1;2;;0.5')"), ['1','2','','0.5']);
assert.deepEqual(read("splitTableRow('1  2  0.3  0.4')"), ['1','2','0.3','0.4']);
console.log('OK: spreadsheet paste preserves empty cells and column alignment.');

assert.deepEqual(read("tableColumnCells('1\\n\\n3')"), ['1','','3']);
assert.deepEqual(read("tableColumnCells('1 2 3')"), ['1','2','3']);
let editedRows = [['1','2','',''], ['3','','','']];
const tableStatus = {textContent:''};
context.document.getElementById = id => id === 'table-count' ? tableStatus : ({
  value:'', querySelectorAll: () => editedRows.map(row=>({querySelectorAll:()=>row.map(value=>({value}))}))
});
vm.runInContext("gridInput=()=>({focus(){}}); tableDatasets=[{analysis_type:'xy',x:'preserved',y:'preserved',ey:'',ex:''}];", context);
assert.equal(vm.runInContext('readGridToDataset()',context), false);
assert.equal(read('tableDatasets[0].x'), 'preserved');
assert.match(tableStatus.textContent, /Row 2/);
editedRows = [['1','2','0.2',''], ['2','4','',''], ['3','6','0.4','']];
assert.equal(vm.runInContext('readGridToDataset()',context), false);
assert.equal(read('tableDatasets[0].x'), 'preserved');
assert.match(tableStatus.textContent, /Missing uncertainties have not been set to zero/);
console.log('OK: incomplete data and uncertainty rows stay in the editor without silent deletion or zero substitution.');

// Excluded rows stay in source inputs but are absent from fitting arrays and errors.
vm.runInContext("datasets[activeIdx].exclusions=[{index:1,x:1,y:5,reason:'test'}];payload=buildPayload(input);",context);
assert.deepEqual(read('payload.x'),[0,2]);assert.deepEqual(read('payload.ey'),[.2,.2]);assert.equal(read('payload.plot.excluded_points[0].reason'),'test');assert.equal(read('input.data.x'),'0 1 2');
assert.throws(()=>vm.runInContext("buildPayload({...input,data:{...input.data,y:'10 6 2.5'}})",context),/Review Point exclusions/);
vm.runInContext('datasets[activeIdx].exclusions=[];payload=buildPayload(input);',context);assert.equal(read('payload.x.length'),3);
console.log('OK: exclusion filtering, shared errors, reasons, restoration and changed-row protection.');
