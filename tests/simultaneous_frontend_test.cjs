// Run with: node tests/simultaneous_frontend_test.cjs
// Frontend checks for simultaneous fits: session model, payload, round trips,
// old documents, Analyze Data objects and covariance propagation.
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const S=require('../frontend/workspace-store.js'), C=require('../frontend/analysis-core.js');

// ---- a minimal DOM so app.js and simultaneous-fit.js load as in the other tests
const elements=new Map();
function el(id){
  if(!elements.has(id)) elements.set(id,{value:'',checked:false,type:'text',hidden:false,disabled:false,textContent:'',title:'',style:{},classList:{toggle(){},contains(){return false;},add(){},remove(){}},
    querySelector(){return {innerHTML:'',appendChild(){}};},querySelectorAll(){return [];},appendChild(){},after(){},focus(){},showModal(){},close(){},addEventListener(){},removeAttribute(){},setAttribute(){}});
  return elements.get(id);
}
const document={getElementById:el,querySelector(){return null;},querySelectorAll(){return [];},createElement(){return {style:{},dataset:{},classList:{add(){},toggle(){}},setAttribute(){},addEventListener(){},querySelector(){return null;},remove(){}};},addEventListener(){},dispatchEvent(){},body:{append(){},appendChild(){}}};
const context=vm.createContext({console,document,setTimeout(){},clearTimeout(){},window:{addEventListener(){},WorkspaceStore:S,AnalysisCore:C},CustomEvent:class{},Event:class{},crypto:{randomUUID:()=>'id-'+Math.random().toString(36).slice(2)}});
vm.runInContext(fs.readFileSync('frontend/app.js','utf8').replace(/\ninit\(\);\s*$/,''),context);
vm.runInContext(fs.readFileSync('frontend/simultaneous-fit.js','utf8'),context);
vm.runInContext('SimultaneousFit=window.SimultaneousFit; WorkspaceStore=window.WorkspaceStore;',context);
const run=x=>vm.runInContext(x,context);
const read=x=>JSON.parse(run(`JSON.stringify(${x})`));

// ---- two decay runs sharing a time constant, one calibration line
run(`writeForm({datasets:[
  {id:'run1',name:'Run 1',analysis_type:'xy',x:'0 1 2 3 4 5',y:'100 61 37 22 14 8',ey:'3',fit:{formula:'[0]*exp(-x/[1])+[2]',param_names:'A, tau, B',initial_guesses:'100, 2, 5',x_min:'',x_max:''},exclusions:[{index:5,x:5,y:8,reason:'late'}]},
  {id:'run2',name:'Run 2',analysis_type:'xy',x:'0 1 2 3 4 5',y:'50 31 19 12 8 6',ey:'2',fit:{formula:'[0]*exp(-x/[1])+[2]',param_names:'A, tau, B',initial_guesses:'50, 2, 3',x_min:'0',x_max:'4'}},
  {id:'cal',name:'Calibration',analysis_type:'xy',x:'1 2 3',y:'2 4 6',fit:{formula:'[0]*x+[1]',param_names:'k, c',initial_guesses:'2, 0',x_min:'',x_max:''}}
 ],simultaneous_fits:[{id:'g1',name:'Decays',members:[{datasetId:'run1',parameters:[{role:'local'},{role:'shared',shared:'tau'},{role:'fixed',value:'5'}]},{datasetId:'run2',parameters:[{role:'local'},{role:'shared',shared:'tau'},{role:'local'}]},{datasetId:'missing',parameters:[]}],shared:[{name:'tau',guess:'2',min:'0.1',max:'10'}]}]})`);
assert.equal(read('simultaneousFits.length'),1);
assert.deepEqual(read('simultaneousFits[0].members.map(m=>m.datasetId)'),['run1','run2'], 'members whose dataset is missing are dropped');
assert.equal(read('readForm().simultaneous_fits[0].shared[0].name'),'tau');

// ---- payload: roles, guesses from the datasets, exclusions, ranges
run('payload=SimultaneousFit.buildPayload(simultaneousFits[0])');
assert.deepEqual(read('payload.parameters.shared'),[{name:'tau',guess:2,min:0.1,max:10}]);
assert.deepEqual(read('payload.parameters.mapping'),[[{kind:'local',guess:100},{kind:'shared',ref:0},{kind:'fixed',value:5}],[{kind:'local',guess:50},{kind:'shared',ref:0},{kind:'local',guess:3}]]);
assert.deepEqual(read('payload.datasets[0].x'),[0,1,2,3,4], 'excluded point removed');
assert.deepEqual(read('payload.datasets[0].excluded_points'),[{index:5,x:5,y:8,reason:'late'}]);
assert.deepEqual(read('payload.datasets[0].ey'),[3,3,3,3,3], 'shared error broadcast');
assert.deepEqual(read('payload.datasets[1].x_range'),[0,4]);
assert.equal(read('payload.datasets[1].x_range')===null,false);
assert.deepEqual(read('payload.datasets.map(d=>d.formula)'),['[0]*exp(-x/[1])+[2]','[0]*exp(-x/[1])+[2]']);
assert.deepEqual(read('payload.datasets[0].param_names'),['A','tau','B']);
assert.equal(read('payload.plot.grid'),true);

// ---- validation
run('bad=JSON.parse(JSON.stringify(simultaneousFits[0]))');
assert.throws(()=>run("SimultaneousFit.buildPayload({...bad,members:bad.members.slice(0,1)})"),/at least two datasets/);
assert.throws(()=>run("SimultaneousFit.buildPayload({...bad,shared:[{name:'tau',guess:'x',min:'',max:''}]})"),/initial guess must be a number/);
assert.throws(()=>run("SimultaneousFit.buildPayload({...bad,shared:[{name:'tau',guess:'',min:'5',max:'1'}]})"),/lower limit must be smaller/);
assert.throws(()=>run("SimultaneousFit.buildPayload({...bad,shared:[{name:'tau',guess:'',min:'',max:''},{name:'other',guess:'',min:'',max:''}]})"),/other is not used/);
assert.throws(()=>run("SimultaneousFit.buildPayload({...bad,members:bad.members.map(m=>({...m,parameters:m.parameters.map(p=>p.role==='shared'?{role:'shared',shared:'gone'}:p)}))})"),/does not exist/);
assert.throws(()=>run("SimultaneousFit.buildPayload({...bad,members:bad.members.map((m,i)=>i?m:{...m,parameters:[{role:'local'},{role:'shared',shared:'tau'},{role:'fixed',value:''}]})})"),/fixed at/);
run("datasets[1].x='0 1 2 3 4 5 6'");
assert.throws(()=>run('SimultaneousFit.buildPayload(bad)'),/X has 7 points but Y has 6/);
run("datasets[1].x='0 1 2 3 4 5'");

// ---- staleness signature reacts to data, ranges and roles
run('sig=WorkspaceStore.groupSignature(simultaneousFits[0],datasets)');
run("datasets[0].y='100 61 37 22 14 9'");assert.notEqual(read('WorkspaceStore.groupSignature(simultaneousFits[0],datasets)'),read('sig'));run("datasets[0].y='100 61 37 22 14 8'");
run("datasets[1].fit.x_max='5'");assert.notEqual(read('WorkspaceStore.groupSignature(simultaneousFits[0],datasets)'),read('sig'));run("datasets[1].fit.x_max='4'");
run("datasets[1].fit.initial_guesses='60, 2, 3'");assert.equal(read('WorkspaceStore.groupSignature(simultaneousFits[0],datasets)'),read('sig'),'guesses do not stale a fit');
run("simultaneousFits[0].members[1].parameters[2]={role:'fixed',value:'3'}");assert.notEqual(read('WorkspaceStore.groupSignature(simultaneousFits[0],datasets)'),read('sig'));
run("simultaneousFits[0].members[1].parameters[2]={role:'local'}");assert.equal(read('WorkspaceStore.groupSignature(simultaneousFits[0],datasets)'),read('sig'));

// ---- a saved simultaneous fit round-trips through JSON exactly
const fake={analysis_type:'simultaneous',name:'Decays',status:0,converged:true,status_message:'Fit converged.',n_datasets:2,n_points:10,n_free:5,
 params:[{index:0,name:'tau',label:'tau',kind:'shared',dataset:null,dataset_name:null,local_index:null,value:2.4,error:0.08,fixed:false,limits:[0.1,10],used_by:[0,1]},
  {index:1,name:'A',label:'A (Run 1)',kind:'local',dataset:0,dataset_name:'Run 1',local_index:0,value:100,error:4,fixed:false,limits:null,used_by:[0]},
  {index:2,name:'B',label:'B (Run 1)',kind:'fixed',dataset:0,dataset_name:'Run 1',local_index:2,value:5,error:0,fixed:true,limits:null,used_by:[0]},
  {index:3,name:'A',label:'A (Run 2)',kind:'local',dataset:1,dataset_name:'Run 2',local_index:0,value:50,error:3,fixed:false,limits:null,used_by:[1]},
  {index:4,name:'B',label:'B (Run 2)',kind:'local',dataset:1,dataset_name:'Run 2',local_index:2,value:3,error:1,fixed:false,limits:null,used_by:[1]}],
 covariance:[[0.0064,-0.12,0,-0.06,0.01],[-0.12,16,0,0.5,0],[0,0,0,0,0],[-0.06,0.5,0,9,0.2],[0.01,0,0,0.2,1]],covariance_status:3,chi2:7.5,ndf:5,chi2_ndf:1.5,prob:0.186,
 datasets:[{index:0,name:'Run 1',formula:'[0]*exp(-x/[1])+[2]',range:[0,4],n_points:5,n_total:5,n_excluded:1,chi2:4.5,x_errors:false,weighted:true,params:[{local_index:0,index:1,name:'A',kind:'local',value:100,error:4,fixed:false},{local_index:1,index:0,name:'tau',kind:'shared',value:2.4,error:0.08,fixed:false},{local_index:2,index:2,name:'B',kind:'fixed',value:5,error:0,fixed:true}]},
  {index:1,name:'Run 2',formula:'[0]*exp(-x/[1])+[2]',range:[0,4],n_points:5,n_total:6,n_excluded:0,chi2:3,x_errors:false,weighted:true,params:[{local_index:0,index:3,name:'A',kind:'local',value:50,error:3,fixed:false},{local_index:1,index:0,name:'tau',kind:'shared',value:2.4,error:0.08,fixed:false},{local_index:2,index:4,name:'B',kind:'local',value:3,error:1,fixed:false}]}],
 x_error_note:null,residuals:{kind:'none'},diagnostics:[],plot_notes:[],formula:'Run 1: [0]*exp(-x/[1])+[2]; Run 2: [0]*exp(-x/[1])+[2]',range:[0,4],confidence_band:null,plot_height:null,canvas_json:{_typename:'TCanvas'},graph_json:null,func_json:null};
run(`simultaneousFits[0].result={response:${JSON.stringify(fake)},payload:payload,sourceSignature:WorkspaceStore.groupSignature(simultaneousFits[0],datasets)}`);
run('saved=JSON.parse(JSON.stringify(readForm())); writeForm(JSON.parse(JSON.stringify(saved))); again=readForm();');
assert.deepEqual(read('again.simultaneous_fits'),read('saved.simultaneous_fits'),'simultaneous fits survive save and load unchanged');
assert.equal(read('again.simultaneous_fits[0].result.response.chi2'),7.5);
// through the shared session store as well
run('doc=WorkspaceStore.normalize(buildDocument()); doc2=WorkspaceStore.normalize(JSON.parse(JSON.stringify(doc)));');
assert.deepEqual(read('doc2.inputs.simultaneous_fits'),read('doc.inputs.simultaneous_fits'));
assert.equal(read('doc.results'),null,'a simultaneous result is never mirrored as a dataset result');

// ---- the stored result can be shown and reported
run('showSimultaneousResult(simultaneousFits[0])');
assert.equal(read('viewingGroup'),'g1');
assert.equal(read('lastResult.analysis_type'),'simultaneous');
const text=run('reportText(lastResult)'), csv=run('reportCsv(lastResult)');
assert.match(text,/Shared parameters:/);assert.match(text,/tau\s+2\.4\s+0\.08\s+Run 1, Run 2/);
assert.match(text,/Dataset:   Run 1 \(5 points, 1 excluded\)/);assert.match(text,/chi2 contribution = 4\.5/);assert.match(text,/B\s+5\s+fixed\s+fixed value/);
assert.match(text,/NDF      = 5/);assert.match(text,/Covariance matrix \(rows and columns: tau, A \(Run 1\), B \(Run 1\), A \(Run 2\), B \(Run 2\)\)/);
assert.match(csv,/^parameter,dataset,role,value,error\n"tau","",shared,2\.4,0\.08\n"A","Run 1",local,100,4\n"B","Run 1",fixed,5,\n/);
assert.match(csv,/dataset,formula,x_min,x_max,points,excluded,chi2,weighted\n"Run 1","\[0\]\*exp\(-x\/\[1\]\)\+\[2\]",0,4,5,1,4\.5,yes/);
assert.match(csv,/covariance,"tau","A \(Run 1\)"/);
run('showDatasetResult()');assert.equal(read('viewingGroup'),null);
// removing a member dataset removes the group and its result
run("datasets.splice(1,1); pruneSimultaneousFits()");
assert.equal(read('simultaneousFits.length'),0);
console.log('OK: session model, payload roles, validation, staleness, exact round trip, report text and CSV.');

// ---- Analyze Data: the group appears as one fit object with the full covariance
const session=S.normalize({version:1,app:'rootfit',inputs:{datasets:[
 {id:'run1',name:'Run 1',analysis_type:'xy',x:'0 1 2 3 4',y:'100 61 37 22 14',ey:'3',fit:{formula:'[0]*exp(-x/[1])+[2]',param_names:'A, tau, B',initial_guesses:'',x_min:'',x_max:''}},
 {id:'run2',name:'Run 2',analysis_type:'xy',x:'0 1 2 3 4',y:'50 31 19 12 8',ey:'2',fit:{formula:'[0]*exp(-x/[1])+[2]',param_names:'A, tau, B',initial_guesses:'',x_min:'',x_max:''}}],
 simultaneous_fits:[{id:'g1',name:'Decays',members:[{datasetId:'run1',parameters:[{role:'local'},{role:'shared',shared:'tau'},{role:'fixed',value:'5'}]},{datasetId:'run2',parameters:[{role:'local'},{role:'shared',shared:'tau'},{role:'local'}]}],shared:[{name:'tau',guess:'2',min:'',max:''}],result:{response:fake,payload:null}}]}});
const objects=S.objects(session), fit=objects.find(o=>o.simultaneous);
assert.ok(fit,'simultaneous fit object exists');
assert.equal(fit.id,'g1:fit');assert.deepEqual(fit.datasetIds,['run1','run2']);
assert.deepEqual(fit.parameters.map(p=>p.name),['tau','A (Run 1)','B (Run 1)','A (Run 2)','B (Run 2)']);
assert.equal(fit.incomplete,false);assert.equal(fit.stale,false,'no signature stored means not stale');
assert.equal(objects.filter(o=>o.kind==='fit').length,1,'member datasets have no separate fit objects');
// propagation of q = tau * A(Run 1) with the full covariance, compared with the hand calculation
const calc={id:'q',kind:'calculation',name:'q',expression:'t\\,a',unit:'',bindings:{t:{id:'g1:fit',key:'0'},a:{id:'g1:fit',key:'1'}}};
const rows=C.engine([...objects,calc]).get('q');
const hand=Math.sqrt(100*100*0.0064+2.4*2.4*16+2*100*2.4*(-0.12));
assert.equal(rows.length,1);assert.ok(Math.abs(rows[0].value-240)<1e-9);
assert.ok(Math.abs(rows[0].uncertainty-hand)<1e-6*hand,`propagated ${rows[0].uncertainty} vs hand ${hand}`);
// the correlation between the two runs' amplitudes enters through the shared parameter
const diff={id:'d',kind:'calculation',name:'d',expression:'a-b',unit:'',bindings:{a:{id:'g1:fit',key:'1'},b:{id:'g1:fit',key:'3'}}};
const d=C.engine([...objects,diff]).get('d')[0];
assert.ok(Math.abs(d.uncertainty-Math.sqrt(16+9-2*0.5))<1e-9);
// a fixed parameter is usable with zero uncertainty
const fixed=C.engine([...objects,{id:'f',kind:'calculation',name:'f',expression:'b',unit:'',bindings:{b:{id:'g1:fit',key:'2'}}}]).get('f')[0];
assert.equal(fixed.value,5);assert.equal(fixed.uncertainty,0);
// deleting the fit object in Analyze Data removes the group's result; renaming renames the group
const view=S.projected(session);
const afterDelete=S.commitView(session,{...view,objects:view.objects.filter(o=>o.id!=='g1:fit')});
assert.equal(afterDelete.inputs.simultaneous_fits[0].result,undefined);
const afterRename=S.commitView(session,{...view,objects:view.objects.map(o=>o.id==='g1:fit'?{...o,name:'Two runs'}:o)});
assert.equal(afterRename.inputs.simultaneous_fits[0].name,'Two runs');
// removing a member dataset in the plotting page drops the group and calculations that used it
const withCalc={...session,objects:[calc]};
const reconciled=S.reconcileDatasets(withCalc,session.inputs.datasets.slice(0,1));
assert.equal(reconciled.inputs.simultaneous_fits,undefined);assert.deepEqual(reconciled.objects,[]);
console.log('OK: Analyze Data object, propagation with shared/local covariance against the hand calculation, deletion, rename and reconciliation.');

// ---- old documents are untouched
for(const file of ['examples/linear.json','examples/exponential-decay.json','examples/gaussian-peak.json','examples/04-count-histogram.json']){
  const raw=JSON.parse(fs.readFileSync(file,'utf8')), before=JSON.stringify(raw);
  const normalized=S.normalize(raw);
  assert.equal(JSON.stringify(raw),before,'normalize does not mutate its input');
  assert.equal('simultaneous_fits' in normalized.inputs,false,file+': no simultaneous_fits key is added');
  run(`applyDocument(${JSON.stringify(normalized)})`);
  assert.equal(read('simultaneousFits.length'),0);
  assert.equal('simultaneous_fits' in read('readForm()'),false,file+': saving adds no key');
}
console.log('OK: old documents load without any simultaneous-fit key.');

// ---- exports: a section, CSV tables and a figure entry per simultaneous fit
global.WorkspaceStore=S;global.AnalysisCore=C;
const X=require('../frontend/analysis-export.js');
const exported=X.report(session,['run1'],{graphs:true,raw:false,fit:true,calculations:false,session:false,notes:false});
assert.match(exported['report.tex'],/\\section\{Simultaneous fit: Decays\}/);
assert.match(exported['report.tex'],/includegraphics\[width=\\linewidth\]\{figures\/simultaneous-1\.png\}/);
assert.match(exported['simultaneous-1-parameters.csv'],/"tau","shared","2\.4","0\.08"/);
assert.match(exported['simultaneous-1-parameters.csv'],/"B","fixed \(Run 1\)","5",""/);
assert.match(exported['simultaneous-1-datasets.csv'],/"Run 1","\[0\]\*exp\(-x\/\[1\]\)\+\[2\]","0 to 4","5","4\.5"/);
assert.match(exported['simultaneous-1-correlation.csv'],/"tau","1",/);
assert.equal(X.report(session,['run1'],{graphs:false,raw:true,fit:false,calculations:false,session:false,notes:false})['simultaneous-1-parameters.csv'],undefined,'raw-only exports leave the fit out');
// the built-in example carries a ready simultaneous fit
run("EXAMPLES.simultaneous && applyDocument({version:1,title:EXAMPLES.simultaneous.title,inputs:EXAMPLES.simultaneous.inputs,results:null})");
assert.equal(read('simultaneousFits.length'),1);assert.deepEqual(read('simultaneousFits[0].members.map(m=>m.datasetId)'),['decay-run-a','decay-run-b']);
run('examplePayload=SimultaneousFit.buildPayload(simultaneousFits[0])');
assert.deepEqual(read('examplePayload.parameters.mapping[1]'),[{kind:'local',guess:40},{kind:'shared',ref:0},{kind:'local',guess:2}]);
assert.deepEqual(read('examplePayload.parameters.shared'),[{name:'tau',guess:2,min:null,max:null}]);
const example=JSON.parse(fs.readFileSync('examples/two-decays-shared-tau.json','utf8'));
assert.equal(S.normalize(example).inputs.simultaneous_fits.length,1,'the example file normalizes with its group');
console.log('OK: LaTeX/CSV export sections and the built-in example.');

// ---- an outdated backend without the endpoint gets a specific message, not the generic one
(async()=>{
  context.AbortController=AbortController;
  context.fetch=async()=>({ok:false,status:405,text:async()=>'<!doctype html><title>405 Method Not Allowed</title>'});
  await assert.rejects(()=>run("callBackend('/simultaneous-fit',{method:'POST',body:'{}'})"),/does not offer this function \(HTTP 405\).*older version/);
  context.fetch=async()=>({ok:false,status:400,text:async()=>JSON.stringify({error:'A simultaneous fit needs at least two datasets.'})});
  await assert.rejects(()=>run("callBackend('/simultaneous-fit',{method:'POST',body:'{}'})"),/at least two datasets/);
  context.fetch=async()=>({ok:false,status:500,text:async()=>'oops'});
  await assert.rejects(()=>run("callBackend('/fit',{method:'POST',body:'{}'})"),/could not finish this request/);
  console.log('OK: outdated-backend errors explain themselves; server errors keep their messages.');
})();
