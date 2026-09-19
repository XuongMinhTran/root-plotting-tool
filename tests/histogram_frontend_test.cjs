const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const elements = new Map();
function el(id) {
  if(!elements.has(id)) elements.set(id, {value:'',checked:false,type:'text',hidden:false,style:{},classList:{toggle(){}},querySelector(){return {innerHTML:'',appendChild(){}};},querySelectorAll(){return [];},children:[],appendChild(child){this.children.push(child);},focus(){},showModal(){},close(){}});
  return elements.get(id);
}
const document={getElementById:el,querySelector(){return null;},querySelectorAll(){return [];},createElement(){return {};}};
const context=vm.createContext({console,document,setTimeout(){},clearTimeout(){},window:{addEventListener(){}}});
vm.runInContext(fs.readFileSync('frontend/app.js','utf8').replace(/\ninit\(\);\s*$/,''),context);
const run=x=>vm.runInContext(x,context);
const read=x=>JSON.parse(run(`JSON.stringify(${x})`));
run(`input={analysis_type:'histogram',histogram:{source:'samples',samples:'0 1 2 3',bins:'3',min:'',max:'',edges:'',method:'poisson'},formula:'gaus',param_names:'',initial_guesses:'',options:{}};`);
assert.equal(read('buildPayload(input).analysis_type'),'histogram');
assert.deepEqual(read('buildPayload(input).histogram.samples'),[0,1,2,3]);
assert.deepEqual(read('buildPayload(input).plot.diagnostics'),[]);
assert.equal(read('buildPayload({...input,formula:""},false).fit_model'),false);
assert.throws(()=>run('buildPayload({...input,formula:""})'),/Choose a histogram/);
assert.throws(()=>run('buildPayload({...input,histogram:{...input.histogram,min:"0"}})'),/both limits/);
assert.throws(()=>run('buildPayload({...input,histogram:{source:"counts",counts:"1 2",edges:"0 1"}})'),/3 edges/);
assert.throws(()=>run('buildPayload({...input,histogram:{source:"counts",counts:"1 -2",edges:"0 1 2"}})'),/whole counts/);
assert.throws(()=>run('buildPayload({...input,histogram:{...input.histogram,edges:"0 1 1"}})'),/increasing/);
assert.equal(read('buildPayload({...input,histogram:{...input.histogram,bins:""}}).histogram').bins, undefined);
assert.equal(read('buildPayload({...input,histogram:{...input.histogram,bins:"1"}}).histogram.bins'), 1);
assert.throws(()=>run('buildPayload({...input,histogram:{...input.histogram,bins:"0"}})'), /whole number/);
// Inactive source values never leak into an analysis request.
assert.deepEqual(read('buildPayload({...input,histogram:{...input.histogram,counts:"bad",edges:"0 1 3",bins:"bad"}}).histogram.edges'),[0,1,3]);
// Documents and dataset switching retain both histogram inputs and XY columns.
run(`writeForm({datasets:[{name:'Spectrum',analysis_type:'histogram',histogram:input.histogram,x:'10 20',y:'30 40'},{name:'Line',x:'1 2',y:'3 4'}],formula:'gaus'}); saved=readForm();`);
assert.equal(read('saved.analysis_type'),'histogram');
assert.equal(read('saved.histogram.samples'),'0 1 2 3');
assert.equal(el('xy-data').hidden,true);
assert.equal(el('histogram-data').hidden,false);
run('setActiveDataset(1)');
assert.equal(el('analysis-type').value,'xy');
run('setActiveDataset(0); restored=readForm();');
assert.deepEqual(read('restored.histogram'),read('saved.histogram'));
assert.equal(read('restored.data.x'),'10 20');
run('writeForm(JSON.parse(JSON.stringify(saved))); roundTrip=readForm();');
assert.deepEqual(read('roundTrip.histogram'),read('saved.histogram'));
// Older documents stay XY and don't inherit a previous histogram selection.
run(`writeForm({data:{x:'1 2',y:'3 4'},formula:'pol1'})`);
assert.equal(el('analysis-type').value,'xy');
for(const name of ['classic','modern']) {
 const html=fs.readFileSync('frontend/'+name+'.html','utf8');
 for(const id of ['analysis-type','histogram-data','hist-samples','hist-counts','hist-edges','hist-method','btn-histogram']) assert(html.includes(`id="${id}"`));
}
console.log('OK: histogram payloads, validation, preview, source isolation, dataset switching, save/load, and legacy XY documents.');

// Menu switching must preserve an edited model, and never seed a histogram from hidden XY data.
run("$('formula').value='[0]*x*x'; functionExamplesMode=null; syncFunctionExamples(true)");
assert.equal(el('formula').value,'[0]*x*x');
const histogramOptions=el('quick-pick').children.slice(-7);
assert.equal(histogramOptions[0].textContent,'Histogram functions…');
assert.deepEqual(histogramOptions.slice(1).map(o=>o.value.split('|')[0]),['gausn','gaus','gaus(0)+pol0(3)','landau','expo','pol0']);
run("$('analysis-type').value='histogram'; autosave=()=>{}; readForm=()=>{throw Error('Histogram must not read XY starts')}; applyFunctionExample('gausn|norm, mean, sigma|')");
assert.equal(el('formula').value,'gausn');
assert.equal(el('param-names').value,'norm, mean, sigma');
assert.equal(el('initial-guesses').value,'');
run('syncFunctionExamples(false)');
assert(el('quick-pick').children.slice(-12).some(o=>o.textContent.startsWith('Straight line')));
assert.equal(el('formula').value,'gausn');
console.log('OK: contextual function menus, parameter names, and preserved custom formulas.');

// Selecting a dataset restores its analysis type, fields, and presets together.
run(`writeForm({datasets:[{name:'XY run',analysis_type:'xy',x:'1 2',y:'3 4'}, {name:'Histogram run',analysis_type:'histogram',histogram:{source:'counts',counts:'4 6',edges:'0 1 2'}}]}); setActiveDataset(1);`);
assert.equal(el('analysis-type').value,'histogram');
assert.equal(el('xy-data').hidden,true);
assert.equal(el('histogram-data').hidden,false);
assert.equal(el('hist-fit-options').hidden,false);
assert.equal(el('hist-counts').value,'4 6');
assert.equal(read('functionExamplesMode'),'histogram');
assert.equal(el('fit-dataset-select').value,'1');
assert.match(el('modern-data-summary').textContent,/Histogram run — Histogram/);
run('duplicateDataset(); setActiveDataset(0)');
assert.equal(el('analysis-type').value,'xy');
assert.equal(el('xy-data').hidden,false);
assert.equal(el('histogram-data').hidden,true);
assert.equal(el('hist-fit-options').hidden,true);
assert.equal(read('functionExamplesMode'),'xy');
run('setActiveDataset(2)');
assert.equal(el('analysis-type').value,'histogram');
run("createTypedDataset('xy')");
assert.equal(el('analysis-type').value,'xy');
assert.equal(read('datasets[activeIdx].analysis_type'),'xy');
console.log('OK: mixed dataset switching, duplicated histogram type, and new XY defaults.');
