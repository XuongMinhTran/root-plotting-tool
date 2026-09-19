const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const elements = new Map();
function el(id) {
  if(!elements.has(id)) elements.set(id, {value:'',checked:false,type:'text',hidden:false,style:{},classList:{toggle(){}},querySelector(){return {innerHTML:'',appendChild(){}};},querySelectorAll(){return [];},appendChild(){},focus(){},showModal(){},close(){},close(){}});
  return elements.get(id);
}
const document={getElementById:el,querySelector(){return null;},querySelectorAll(){return [];},createElement(){return {};}};
const context=vm.createContext({console,document,setTimeout(){},clearTimeout(){},window:{addEventListener(){}}});
vm.runInContext(fs.readFileSync('frontend/app.js','utf8').replace(/\ninit\(\);\s*$/,''),context);
const run=x=>vm.runInContext(x,context);
const read=x=>JSON.parse(run(`JSON.stringify(${x})`));

run(`writeForm({datasets:[{name:'A',x:'0 1 2',y:'2 4 6'},{name:'B',x:'0 1 2',y:'10 5 2'}],formula:'[0]*x+[1]',param_names:'slope, intercept',initial_guesses:'2, 2',options:{x_min:'0',x_max:'2'}})`);
// Legacy shared settings migrate to independent copies for each dataset.
assert.equal(read('datasets[1].fit.initial_guesses'),'2, 2');
el('formula').value='pol2';el('param-names').value='a,b,c';el('initial-guesses').value='1,2,3';el('fit-xmin').value='1';
run('setActiveDataset(1)');
assert.equal(el('formula').value,'[0]*x+[1]');
assert.equal(el('initial-guesses').value,'2, 2');
el('formula').value='[0]*exp(-x/[1])';el('initial-guesses').value='10, 1';
run('setActiveDataset(0)');
assert.equal(el('formula').value,'pol2');
assert.equal(el('param-names').value,'a,b,c');
assert.equal(el('initial-guesses').value,'1,2,3');
assert.equal(el('fit-xmin').value,'1');
run("createTypedDataset('xy')");
assert.equal(el('formula').value,'[0]*x+[1]');
assert.equal(el('initial-guesses').value,'');
assert.equal(el('fit-xmin').value,'');
run('saved=readForm(); writeForm(JSON.parse(JSON.stringify(saved))); setActiveDataset(1);');
assert.equal(el('formula').value,'[0]*exp(-x/[1])');
assert.equal(el('initial-guesses').value,'10, 1');
// The table editor edits a private copy; Cancel cannot change the analysis.
run('syncActiveFromColumns(); tableDatasets=datasets.map(d=>({...d,fit:{...d.fit}})); tableActive=1; writeTableFit();');
assert.equal(el('table-fit-formula').value,'[0]*exp(-x/[1])');
el('table-fit-formula').value='gaus';el('table-fit-initial_guesses').value='20,3,1';
run('readTableFit();');
assert.equal(read('tableDatasets[1].fit.formula'),'gaus');
assert.equal(read('datasets[1].fit.formula'),'[0]*exp(-x/[1])');
run('tableCancel()');
assert.equal(read('datasets[1].fit.formula'),'[0]*exp(-x/[1])');
// A table-created dataset gets fresh fields; Done applies its settings.
run("tableDatasets=datasets.map(d=>({...d,fit:{...d.fit}})); tableDatasets.push(newDataset('D')); tableActive=tableDatasets.length-1; writeTableFit();");
assert.equal(el('table-fit-formula').value,'[0]*x+[1]');
assert.equal(el('table-fit-initial_guesses').value,'');
el('table-fit-formula').value='pol2';el('table-fit-param_names').value='offset,slope,curvature';el('table-fit-initial_guesses').value='3,2,1';el('table-fit-x_max').value='5';
run('tableDone();');
assert.equal(el('formula').value,'pol2');
assert.equal(el('param-names').value,'offset,slope,curvature');
assert.equal(el('initial-guesses').value,'3,2,1');
assert.equal(el('fit-xmax').value,'5');
run('roundTrip=readForm(); writeForm(roundTrip);');
assert.equal(read('readForm().datasets[3].fit.formula'),'pol2');
console.log('OK: per-dataset fits, clean defaults, legacy migration, save/load, table edits, Cancel and Done.');
// Main controls update the same per-dataset settings immediately, including range.
el('formula').value='gausn';el('param-names').value='norm,mean,sigma';el('initial-guesses').value='100,5,1';el('fit-xmin').value='2';el('fit-xmax').value='8';
run('syncDatasetFit()');
assert.deepEqual(read('datasets[activeIdx].fit'),{formula:'gausn',param_names:'norm,mean,sigma',initial_guesses:'100,5,1',x_min:'2',x_max:'8'});
assert.equal(el('fit-dataset-select').value,'3');
run('setActiveDataset(0)');
assert.equal(el('fit-dataset-select').value,'0');
assert.equal(el('dataset-select').value,'0');
assert.equal(el('formula').value,'pol2');
run('setActiveDataset(3); tableDatasets=datasets.map(d=>({...d,fit:{...d.fit}})); tableActive=3; writeTableFit();');
assert.equal(el('table-fit-formula').value,'gausn');
assert.equal(el('table-fit-x_min').value,'2');
// Capture all pending fields when leaving a table, even without an input event.
el('table-fit-param_names').value='area,center,width';
run('readGridToDataset()');
assert.equal(read('tableDatasets[3].fit.param_names'),'area,center,width');
run('tableDone()');
assert.equal(el('param-names').value,'area,center,width');
assert.equal(el('fit-dataset-select').value,'3');
console.log('OK: main fit selector, immediate field synchronization, and table-to-main parameter updates.');
// Duplicate captures unsaved main inputs and makes independent nested settings.
run(`writeForm({datasets:[{name:'Run',x:'1 2',y:'3 4',ex:'0.1',ey:'0.2',fit:{formula:'pol1',param_names:'offset,slope',initial_guesses:'1,2',x_min:'1',x_max:'2'},histogram:{samples:'7 8'}}]});`);
el('initial-guesses').value='5,6';
run('duplicateDataset()');
assert.equal(read('activeIdx'),1);
assert.equal(read('datasets[1].name'),'Run (copy)');
assert.equal(read('datasets[1].x'),'1 2');
assert.equal(read('datasets[1].ey'),'0.2');
assert.equal(el('initial-guesses').value,'5,6');
run("datasets[1].fit.formula='gaus'; datasets[1].histogram.samples='9';");
assert.equal(read('datasets[0].fit.formula'),'pol1');
assert.equal(read('datasets[0].histogram.samples'),'7 8');
run('setActiveDataset(0); duplicateDataset();');
assert.equal(read('datasets[1].name'),'Run (copy 2)');
run('saved=readForm(); writeForm(saved)');
assert.equal(read('datasets.length'),3);
assert.equal(el('fit-dataset-select').value,'1');
// Table duplication is provisional until Done, and preserves pending fit edits.
run('tableDatasets=JSON.parse(JSON.stringify(datasets)); tableActive=0; writeTableFit(); renderTabs=()=>{}; renderGrid=()=>writeTableFit();');
el('table-fit-initial_guesses').value='8,9';
run('tableDuplicateDataset()');
assert.equal(read('tableDatasets.length'),4);
assert.equal(read('tableDatasets[1].fit.initial_guesses'),'8,9');
assert.equal(read('datasets.length'),3);
run('tableCancel()');
assert.equal(read('datasets.length'),3);
run('tableDatasets=JSON.parse(JSON.stringify(datasets)); tableActive=0; writeTableFit(); tableDuplicateDataset(); tableDone();');
assert.equal(read('datasets.length'),4);
assert.equal(read('activeIdx'),1);
console.log('OK: duplicate data and fits, independent copies, unique names, persistence, table Done and Cancel.');
// Start untyped, then use analysis type as a filter without converting data.
run("writeForm({datasets:[newDataset('Dataset 1','')]});");
assert.equal(el('analysis-type').value,'');
assert.equal(el('xy-data').hidden,true);
assert.equal(el('histogram-data').hidden,true);
assert.equal(el('btn-fit').disabled,true);
run("changeAnalysisType('xy')");
el('col-x').value='1 2';el('col-y').value='3 4';
run("changeAnalysisType('histogram')");
assert.equal(read('datasets.length'),2);
assert.equal(read('datasets[0].analysis_type'),'xy');
assert.equal(read('datasets[0].x'),'1 2');
assert.equal(el('analysis-type').value,'histogram');
run("changeAnalysisType('xy')");
assert.equal(read('activeIdx'),0);
assert.equal(el('col-y').value,'3 4');
run('addingInTable=false; addDataset()');
assert.equal(read('datasets.length'),2); // Opening the chooser creates nothing.
run("createTypedDataset('histogram')");
assert.equal(read('datasets.length'),3);
assert.equal(el('analysis-type').value,'histogram');
run('saved=readForm(); writeForm(saved)');
assert.equal(el('analysis-type').value,'histogram');
console.log('OK: initial type selection, type filtering without conversion, and explicit new dataset type.');

// Both interfaces share deletion, including the final XY or histogram dataset.
context.confirm = () => true;
let resetCount = 0;
context.recordReset = () => resetCount++;
run('resetResult=()=>recordReset();');
for (const type of ['xy','histogram']) {
  run(`writeForm({datasets:[newDataset('Only dataset','${type}')]}); removeDataset();`);
  assert.equal(el('analysis-type').value,'');
  assert.equal(el('btn-fit').disabled,true);
  assert.equal(read('datasets.filter(d=>d.analysis_type).length'),0);
  run(`changeAnalysisType('${type}')`);
  assert.equal(read('datasets.filter(d=>d.analysis_type).length'),1);
  if (type === 'histogram') assert.equal(el('formula').value,'gausn');
}
assert.equal(resetCount,2);
run("writeForm({datasets:[newDataset('Only dataset','xy')]}); tableDatasets=JSON.parse(JSON.stringify(datasets)); tableActive=0; tableRemoveDataset(0); tableCancel();");
assert.equal(read('datasets[0].analysis_type'),'xy', 'Cancel preserves the deleted table');
run("tableDatasets=JSON.parse(JSON.stringify(datasets)); tableActive=0; tableRemoveDataset(0); tableDone();");
assert.equal(el('analysis-type').value,'');
// Modern no longer contains a second dataset selector.
document.getElementById = id => ['fit-dataset-select','fit-dataset-label'].includes(id) ? null : el(id);
run("changeAnalysisType('histogram'); renderDatasetSelector();");
assert.equal(el('formula').value,'gausn');
console.log('OK: final dataset deletion, empty state, new analysis, table Cancel/Done, and Modern without a fit selector.');

// Classic and the table editor preserve Modern's equation metadata until the ROOT expression changes.
run(`writeForm({datasets:[{name:'Equation',analysis_type:'xy',fit:{formula:'[0]*x+[1]',param_names:'m,b',initial_guesses:'2,1',equation:{formula:'[0]*x+[1]',latex:'m x+b',parameters:['m','b'],mode:'equation',error:'',cache:{}}}}]});`);
assert.equal(read('readForm().datasets[0].fit.equation.latex'),'m x+b');
run(`tableDatasets=JSON.parse(JSON.stringify(datasets)); tableActive=0; writeTableFit(); $('table-fit-initial_guesses').value='3,4'; readTableFit();`);
assert.equal(read('tableDatasets[0].fit.equation.latex'),'m x+b');
run(`$('table-fit-formula').value='pol2'; readTableFit();`);
assert.equal(run('tableDatasets[0].fit.equation'),undefined);
run(`$('formula').value='[0]*x'; syncDatasetFit();`);
assert.equal(run('datasets[0].fit.equation'),undefined);
console.log('OK: equation metadata survives Classic, save/load and table edits; changed ROOT formulas invalidate the old equation.');

// Selection restores only the selected dataset's plot and report.
run(`renderReport=r=>{globalThis.reportShown=r}; drawPlot=r=>{globalThis.plotShown=r};
 showMessage=()=>{}; setStatus=()=>{}; clearReport=()=>{globalThis.reportShown=null};
 writeForm({datasets:[{name:'A',result:{response:{params:[],tag:'A'},payload:{dataset_name:'A'}}},
 {name:'B',result:{response:{params:[],tag:'B'},payload:{dataset_name:'B'}}},{name:'C'}]});`);
assert.equal(read('lastResult.tag'),'A');
run('setActiveDataset(1)');assert.equal(read('plotShown.tag'),'B');assert.equal(read('reportShown.tag'),'B');
run('setActiveDataset(2)');assert.equal(read('lastResult'),null);assert.equal(read('reportShown'),null);
assert.match(el('plot').innerHTML,/No result for this dataset/);
run('setActiveDataset(0)');assert.equal(read('lastResult.tag'),'A');
run('globalThis.savedInputs=readForm(); writeForm(savedInputs); setActiveDataset(1)');
assert.equal(read('lastResult.tag'),'B');
console.log('OK: per-dataset plots/reports, unfitted empty state, and result persistence.');
(async()=>{
 run(`globalThis.namePrompt=null; askDialog=async options=>{namePrompt=options; return null};`);
 const before=read('datasets.length');
 await run("requestNewDataset('xy',false)");
 assert.equal(read('datasets.length'),before);
 assert.throws(()=>run("namePrompt.validate('   ')"),/Enter a dataset name/);
 assert.equal(run("namePrompt.validate('  Voltage sweep  ')"),'Voltage sweep');
 run("askDialog=async options=>options.validate('  Voltage sweep  ')");
 await run("requestNewDataset('xy',false)");
 assert.equal(read('datasets[activeIdx].name'),'Voltage sweep');
 console.log('OK: new dataset requires a trimmed name; cancellation creates no dataset.');
})().catch(error=>{console.error(error);process.exitCode=1;});
