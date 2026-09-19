const assert=require('node:assert/strict'),S=require('../frontend/workspace-store.js'),C=require('../frontend/analysis-core.js');
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
let doc=S.normalize({version:1,app:'rootfit',title:'Laboratory',notes:'Keep these notes',inputs:{datasets:[{name:'Decay',analysis_type:'xy',x:'0 1 2',y:'10 5 3',ey:'1',fit:{formula:'[0]*exp(-x/[1])'},result:{response:{params:[{name:'A',value:10,error:1},{name:'tau',value:2,error:.1}],covariance:[[1,.02],[.02,.01]],canvas_json:{_typename:'TCanvas',fixture:'preserved'},formula:'[0]*exp(-x/[1])'},payload:null}}],active:0,graph_title:'Decay',options:{grid:true}},objects:[]});
const datasetId=doc.inputs.datasets[0].id;
let v=S.projected(doc);assert.equal(v.objects.length,2);assert.equal(v.objects[0].id,datasetId);
const fitId=v.objects[1].id;
v.objects.push({id:'half',name:'Half-life',kind:'calculation',expression:'t\\ln(2)',unit:'s',bindings:{t:{id:fitId,key:'1'}}});
doc=S.commitView(doc,v);let engine=C.engine(S.usableObjects(doc));assert(Math.abs(engine.get('half')[0].value-2*Math.log(2))<1e-10);
// A file saved in either page is the SAME canonical document, including canvas and notes.
let reopened=S.normalize(JSON.parse(JSON.stringify(doc)));assert.equal(reopened.inputs.datasets[0].result.response.canvas_json.fixture,'preserved');assert.equal(reopened.notes,'Keep these notes');assert.equal(reopened.objects[0].bindings.t.id,fitId);
// Refitting updates the linked parameters, not a separately imported snapshot.
reopened.inputs.datasets[0].result.response.params[1].value=4;assert(Math.abs(C.engine(S.usableObjects(reopened)).get('half')[0].value-4*Math.log(2))<1e-10);
// Editing raw data marks the old fit stale and blocks dependent calculations.
reopened.inputs.datasets[0].y='11 6 4';assert.throws(()=>C.engine(S.usableObjects(reopened)).get('half'),/Refit/);
// Manual data entered in DA appears in plotting; extra columns survive.
v=S.projected(doc);v.objects.push({id:'manual',name:'Measurements',kind:'measurements',columns:[{name:'Time',unit:'s',values:[1,2],errors:[.1,.1]},{name:'Voltage',unit:'V',values:[4,8],errors:[.2,.2]},{name:'Temperature',unit:'K',values:[290,291]}]});
doc=S.commitView(doc,v);assert.equal(doc.inputs.datasets[1].y,'4\n8');assert.equal(doc.inputs.datasets[1].measurementColumns.length,3);
// Column transformations are available to plot and stay linked to raw input.
v=S.projected(doc);v.objects.push({id:'scaled',kind:'calculation',name:'Doubled voltage',expression:'2v',bindings:{v:{id:'manual',key:'1'}}});doc=S.commitView(doc,v);
let derived=doc.inputs.datasets.find(d=>d.derivedFrom==='scaled');assert.equal(derived.y,'8\n16');
doc.inputs.datasets.find(d=>d.id==='manual').y='5\n9';S.materialize(doc);assert.equal(derived.y,'10\n18');
// Selection exposes the same dataset in the plotting controls.
v=S.projected(doc);v.selected='manual';doc=S.commitView(doc,v);assert.equal(doc.inputs.datasets[doc.inputs.active].id,'manual');
// Stable IDs survive rename, serialization, and reload.
doc.inputs.datasets[0].name='Renamed';reopened=S.normalize(JSON.parse(JSON.stringify(doc)));assert.equal(reopened.inputs.datasets[0].id,datasetId);
// Existing DA files migrate rather than becoming a second document store.
const old={app:'gauss-analysis',version:1,title:'Old',objects:[{id:'old-raw',kind:'measurements',name:'Old raw',columns:[{name:'x',values:[1,2]},{name:'y',values:[3,4]}]}]};
assert.equal(S.normalize(old).inputs.datasets[0].id,'old-raw');
const storage=memory();doc=S.write(storage,doc);storage.setItem('gauss.analysis.v1',JSON.stringify({document:old}));doc=S.migrate(storage);assert.equal(storage.getItem('gauss.analysis.v1'),null);assert(doc.inputs.datasets.some(d=>d.id==='old-raw'));
// A stale browser tab must not overwrite a newer session.
const stale=JSON.parse(JSON.stringify(doc));doc=S.write(storage,doc);assert.throws(()=>S.write(storage,stale),/another tab/);
// Deletion must not resurrect the legacy top-level last result.
v=S.projected(doc);v.objects=v.objects.filter(o=>o.id!==datasetId&&o.id!==fitId&&o.id!=='half');v.selected='manual';doc=S.commitView(doc,v);assert(!S.normalize(doc).inputs.datasets.some(d=>d.id===datasetId));
console.log('OK: shared JSON, raw and fit selection, canvas preservation, refit links, stale results, derived plots, metadata, migration, concurrency and deletion.');

const legacyXY=S.normalize({version:1,inputs:{datasets:[{name:'Old XY',x:'1 2',y:'3 4'}]}});assert.equal(S.projected(legacyXY).objects[0].name,'Old XY');
assert.equal(S.commitView(legacyXY,S.projected(legacyXY)).inputs.datasets.length,1);
// Deleting a derived dataset in plotting must not recreate it in Analyze Data.
{
 const original=S.empty();
 original.inputs.datasets=[{id:'source',name:'Source',analysis_type:'xy',x:'1 2',y:'3 4',fit:{formula:'[0]*x'}}];
 original.objects=[{id:'twice',kind:'calculation',name:'Twice Y',expression:'2y',bindings:{y:{id:'source',key:'1'}}}];
 S.materialize(original);
 assert(original.inputs.datasets.some(d=>d.derivedFrom==='twice'));
 const removed=S.reconcileDatasets(original,original.inputs.datasets.filter(d=>!d.derivedFrom));
 S.materialize(removed);assert.equal(removed.inputs.datasets.length,1);assert.equal(removed.objects.length,0);
 const deletedSource=S.reconcileDatasets(original,original.inputs.datasets.filter(d=>d.id!=='source'));
 S.materialize(deletedSource);assert.equal(deletedSource.inputs.datasets.length,0);assert.equal(deletedSource.objects.length,0);
 original.workspace.selected='deleted-selection';assert(S.projected(original).selected!=='deleted-selection');
 const added=S.commitView(removed,{...S.projected(removed),objects:[...S.objects(removed),{id:'new',kind:'measurements',name:'New measurements',columns:[{name:'x',values:[1,2]},{name:'y',values:[5,6]}]}],selected:'new'});
 assert(added.inputs.datasets.some(d=>d.id==='new'));
 const loaded=S.normalize(JSON.parse(JSON.stringify(added)));assert.deepEqual(loaded.inputs.datasets,added.inputs.datasets);
 console.log('OK: shared creation, file reload, deletion of sources and derived datasets, and selection fallback.');
}
