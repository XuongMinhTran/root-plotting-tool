const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const S=require('../frontend/workspace-store.js');
const elements=new Map(),storage=new Map();
const el=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,hidden:false,style:{},classList:{toggle(){}},querySelector(){return{innerHTML:'',appendChild(){}};},querySelectorAll(){return[]},appendChild(){},focus(){}});return elements.get(id)};
const context=vm.createContext({console,document:{getElementById:el,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({}),dispatchEvent(){}},CustomEvent:class{},window:{WorkspaceStore:S,addEventListener(){}},setTimeout(){},clearTimeout(){},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}});
vm.runInContext(fs.readFileSync('frontend/app.js','utf8').replace(/\ninit\(\);\s*$/,''),context);
const run=s=>vm.runInContext(s,context);
run('renderReport=()=>{};drawPlot=()=>{};showMessage=()=>{};clearReport=()=>{};setStatus=()=>{};backendUrl=()=>"http://localhost:8000";');
let doc=S.normalize({app:'rootfit',version:1,title:'Shared round trip',notes:'Complete session',inputs:{datasets:[{name:'Run',analysis_type:'xy',x:'1 2 3',y:'2 4 6',ey:'.1',fit:{formula:'[0]*x'},result:{response:{params:[{name:'slope',value:2,error:.1}],covariance:[[.01]],canvas_json:{_typename:'TCanvas'}},payload:null}}]},objects:[]});
const source=doc.inputs.datasets[0].id;
doc.objects.push({id:'quantity',name:'Inverse slope',kind:'calculation',expression:'1/a',unit:'',bindings:{a:{id:source+':fit',key:'0'}}});
context.file=doc;run('applyDocument(file)');
let saved=JSON.parse(run('JSON.stringify(buildDocument())'));assert.equal(saved.objects.length,1);assert.equal(saved.notes,'Complete session');assert(saved.inputs.datasets[0].result.response.canvas_json);assert.equal(saved.inputs.datasets[0].id,source);
// Simulate closing the page and loading its saved JSON through the actual app loader.
context.fileText=JSON.stringify(saved);assert.equal(run('loadDocumentText(fileText,"roundtrip.json")'),true);
saved=JSON.parse(run('JSON.stringify(buildDocument())'));assert.equal(saved.objects[0].bindings.a.id,source+':fit');
assert.equal(run('autosaveNow()'),true);const stored=S.read(context.localStorage);assert.equal(stored.objects[0].name,'Inverse slope');
// Plotting changes preserve extra raw columns and the calculation definitions.
const raw={id:'manual',kind:'measurements',name:'Multicolumn',columns:[{name:'Time',values:[1,2]},{name:'Voltage',values:[2,4]},{name:'Temperature',values:[20,21]}]};
const view=S.projected(stored);view.objects.push(raw);context.file=S.commitView(stored,view);run('applyDocument(file)');
el('doc-notes').value='Edited from Classic';saved=JSON.parse(run('JSON.stringify(buildDocument())'));assert.equal(saved.inputs.datasets.find(d=>d.id==='manual').measurementColumns.length,3);assert.equal(saved.objects.length,1);
// Explicit file loading rebases the storage revision; stale tabs cannot overwrite.
assert.equal(run('autosaveNow()'),true);context.fileText=JSON.stringify(doc);assert.equal(run('loadDocumentText(fileText,"older-file.json")'),true);assert.equal(run('autosaveNow()'),true);
console.log('OK: actual plotting load/save preserves shared calculations, identities, canvases, extra columns, notes and revision rebasing.');
