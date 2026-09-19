/* One portable document and one browser session for every workspace. */
(function(scope){
'use strict';
const C=typeof module==='object'?require('./analysis-core.js'):scope.AnalysisCore;
const KEY='rootfit.autosave', LEGACY='gauss.analysis.v1', clone=x=>JSON.parse(JSON.stringify(x));
let serial=0;
const id=()=>scope.crypto?.randomUUID?.() || 'dataset-'+Date.now().toString(36)+'-'+(++serial);
const list=s=>Array.isArray(s)?s.map(Number):String(s??'').trim().split(/[\s,;]+/).filter(Boolean).map(Number);
const text=a=>(a||[]).join('\n');
const fitDefaults=()=>({formula:'[0]*x+[1]',param_names:'',initial_guesses:'',x_min:'',x_max:''});
function empty(){return {app:'rootfit',version:1,workspace_version:1,title:'',notes:'',inputs:{datasets:[],active:0,options:{}},objects:[],workspace:{selected:null},revision:null};}
function signature(d){const n=list(d.x).length,errors=s=>{const a=list(s);return a.length===1?Array(n).fill(a[0]):a;};return JSON.stringify({type:d.analysis_type||'xy',x:list(d.x),y:list(d.y),ex:errors(d.ex),ey:errors(d.ey),histogram:d.histogram||null,formula:d.fit?.formula||'',...(d.exclusions?.length?{exclusions:d.exclusions}:{} )});}
function sourceColumns(d){
 if(d.analysis_type==='histogram'){
  const h=d.histogram||{};
  if(h.source==='counts')return[{name:'Bin counts',unit:'',values:list(h.counts),errors:list(h.counts).map(v=>Math.sqrt(v))}];
  return[{name:'Measurements',unit:'',values:list(h.samples)}];
 }
 const columns=clone(d.measurementColumns||[]),mapping=d.columnMapping||{x:0,y:1};
 for(const axis of ['x','y']){
  const values=list(d[axis]),errors=list(d['e'+axis]),index=mapping[axis];
  if(index===null||index===undefined)continue;
  const old=columns[index]||{name:axis,unit:''};
  columns[index]={...old,values};
  if(errors.length)columns[index].errors=errors.length===1?values.map(()=>errors[0]):errors;else delete columns[index].errors;
 }
 return columns.filter(Boolean);
}
function measurementDataset(o,old={}){
 const cols=clone(o.columns),m=old.columnMapping||{x:cols.length>1?0:null,y:cols.length>1?1:0};
 const y=cols[m.y]||cols[0],x=m.x===null?null:cols[m.x];
 return {...old,id:o.id,name:o.name,analysis_type:'xy',measurementColumns:cols,columnMapping:m,
  x:text(x?.values||y.values.map((_,i)=>i+1)),y:text(y.values),ex:text(x?.errors),ey:text(y.errors),fit:old.fit||fitDefaults()};
}
function normalize(input){
 if(!input||typeof input!=='object')throw Error('Choose a saved ROOT-A-TRON analysis document.');
 if(input.app==='gauss-analysis')return {...fromOldAnalysis(input),revision:input.revision||null};
 if(input.version!==1||!input.inputs)throw Error('This file is not a supported analysis document.');
 const doc=clone(input);doc.app='rootfit';doc.workspace_version=1;doc.objects=Array.isArray(doc.objects)?doc.objects:[];doc.workspace=doc.workspace||{selected:null};doc.revision=doc.revision||null;
 if(!Array.isArray(doc.inputs.datasets)){
  doc.inputs.datasets=[{name:'Dataset 1',analysis_type:doc.inputs.analysis_type||'xy',...doc.inputs.data,fit:{...fitDefaults(),formula:doc.inputs.formula||'[0]*x+[1]',param_names:doc.inputs.param_names||'',initial_guesses:doc.inputs.initial_guesses||''}}];
 }
 const used=new Set();
 for(const d of doc.inputs.datasets){
  if(!d.id||used.has(d.id))d.id=id();used.add(d.id);
  d.name=String(d.name||'Dataset');d.analysis_type=d.analysis_type===''?'':d.analysis_type==='histogram'?'histogram':'xy';d.fit=d.fit||{...fitDefaults(),formula:doc.inputs.formula||'[0]*x+[1]',param_names:doc.inputs.param_names||'',initial_guesses:doc.inputs.initial_guesses||''};
 }
 if(doc.results&&!doc.inputs.datasets.some(d=>d.result)){
  const owner=doc.inputs.datasets.find(d=>d.name===doc.results_payload?.dataset_name)||doc.inputs.datasets[doc.inputs.active||0];
  if(owner)owner.result={response:doc.results,payload:doc.results_payload||null};
 }
 for(const d of doc.inputs.datasets)if(d.result&&!d.result.sourceSignature){
  const p=d.result.payload;
  d.result.sourceSignature=p&&p.x?signature({...d,x:text(p.x),y:text(p.y),ex:text(p.ex),ey:text(p.ey),fit:{...d.fit,formula:p.formula||d.fit.formula}}):signature(d);
 }
 return doc;
}
function fromOldAnalysis(old){
 const doc=empty();doc.title=old.title||'';doc.workspace.selected=old.selected;
 for(const o of old.objects||[]){
  if(o.kind==='measurements')doc.inputs.datasets.push(measurementDataset(o));
  else if(o.kind==='fit'){
   const datasetId=id();doc.inputs.datasets.push({id:datasetId,name:o.name,analysis_type:'xy',x:'',y:'',ex:'',ey:'',fit:{...fitDefaults(),formula:o.formula||''},result:{objectId:o.id,response:{params:o.parameters.map((p,i)=>({...p,index:i})),covariance:o.covariance,formula:o.formula,converged:o.converged!==false},payload:null}});
  }else doc.objects.push(clone(o));
 }
 return doc;
}
function objects(doc){
 const out=clone(doc.objects||[]);
 for(const o of out){delete o.datasetId;const d=doc.inputs.datasets.find(d=>d.derivedFrom===o.id);if(d)o.datasetId=d.id;}
 for(const d of doc.inputs.datasets){
  if(!d.analysis_type)continue;
  if(!d.derivedFrom){
   const columns=sourceColumns(d);
   out.push({id:d.id,name:d.name,kind:'measurements',columns,datasetId:d.id,analysis_type:d.analysis_type,origin:'Raw data',incomplete:!columns.length||columns.some(c=>!c.values.length||c.values.length!==columns[0].values.length||c.values.some(v=>!Number.isFinite(v))||c.errors&&(c.errors.length!==c.values.length||c.errors.some(v=>!Number.isFinite(v)||v<0))) });
  }
  if(d.result?.response){
   const f=d.result.response;
   out.push({id:d.result.objectId||d.id+':fit',datasetId:d.id,kind:'fit',name:d.name+' — fit',origin:'Fit results',formula:f.formula,converged:f.converged,parameters:(f.params||[]).map((p,i)=>({name:p.name||'p'+i,value:p.value,error:p.error,unit:p.unit||''})),covariance:f.covariance,
    incomplete:!f.params?.length,stale:!!d.result.sourceSignature&&d.result.sourceSignature!==signature(d)});
  }
 }
 return out;
}
function usableObjects(doc){return objects(doc).filter(o=>!o.incomplete);}
function syncObjects(doc,updated){
 const old=objects(doc),oldById=new Map(old.map(o=>[o.id,o])),nextIds=new Set(updated.map(o=>o.id));
 doc.inputs.datasets=doc.inputs.datasets.filter(d=>d.derivedFrom?nextIds.has(d.derivedFrom):nextIds.has(d.id)||nextIds.has(d.result?.objectId||d.id+':fit'));
 for(const d of doc.inputs.datasets)if(d.result&&!nextIds.has(d.result.objectId||d.id+':fit'))delete d.result;
 const values=[];
 for(const o of updated){
  if(o.kind==='measurements'){
   const at=doc.inputs.datasets.findIndex(d=>d.id===o.id),previous=oldById.get(o.id);
   if(previous&&JSON.stringify(previous.columns)===JSON.stringify(o.columns)){doc.inputs.datasets[at].name=o.name;continue;}
   if(o.analysis_type==='histogram'&&at>=0){
    const d=doc.inputs.datasets[at],field=d.histogram?.source==='counts'?'counts':'samples';d.name=o.name;d.histogram={...d.histogram,[field]:text(o.columns[0].values)};
   }else{const d=measurementDataset(o,at>=0?doc.inputs.datasets[at]:{});if(at<0)doc.inputs.datasets.push(d);else doc.inputs.datasets[at]=d;}
  }else if(o.kind==='fit'){
   if(oldById.has(o.id))continue;
   // Old DA documents and examples may contain a fit without raw measurements.
   const temp=fromOldAnalysis({objects:[o]});doc.inputs.datasets.push(...temp.inputs.datasets);
  }else {const value=clone(o);delete value.datasetId;values.push(value);}
 }
 doc.objects=values;
 materialize(doc);
 return doc;
}
function materialize(doc){
 const candidates=usableObjects(doc);let engine;
 try{engine=C.engine(candidates);}catch(error){
  for(const d of doc.inputs.datasets)if(d.derivedFrom){d.y='';d.ey='';d.calculationError=error.message;}
  return doc;
 }
 for(const o of doc.objects||[]){
  if(o.kind!=='calculation'||o.resultMode==='column')continue;
  let rows;try{rows=engine.get(o.id);}catch{const d=doc.inputs.datasets.find(d=>d.derivedFrom===o.id);if(d){d.y='';d.ey='';d.calculationError='A source is missing, incomplete, or has changed. Open Analyze Data to inspect the calculation.';}continue;}
  let d=doc.inputs.datasets.find(d=>d.derivedFrom===o.id);
  if(!d&&rows.length<2)continue;
  if(!d){d={id:id(),name:o.name,analysis_type:'xy',derivedFrom:o.id,x:'',ex:'',fit:fitDefaults()};doc.inputs.datasets.push(d);}
  if(list(d.x).length!==rows.length)d.x=text(rows.map((_,i)=>i+1));
  d.name=o.name;d.y=text(rows.map(r=>r.value));d.ey=rows.every(r=>r.uncertainty!==null)?text(rows.map(r=>r.uncertainty)):'';delete d.calculationError;
 }
 return doc;
}
function reconcileDatasets(previous,datasets){
 const doc=clone(previous),kept=new Set(datasets.map(d=>d.id)),removed=new Set();
 for(const d of previous.inputs.datasets)if(!kept.has(d.id)){
  removed.add(d.id);removed.add(d.result?.objectId||d.id+':fit');if(d.derivedFrom)removed.add(d.derivedFrom);
 }
 let changed=true;
 while(changed){changed=false;for(const o of doc.objects||[])if(!removed.has(o.id)&&(removed.has(o.ownerDatasetId)||Object.values(o.bindings||{}).some(b=>removed.has(b.id)))){removed.add(o.id);changed=true;}
  for(const d of datasets)if(d.derivedFrom&&removed.has(d.derivedFrom)&&!removed.has(d.id)){removed.add(d.id);removed.add(d.result?.objectId||d.id+':fit');changed=true;}
 }
 doc.objects=(doc.objects||[]).filter(o=>!removed.has(o.id));
 doc.inputs.datasets=datasets.filter(d=>!removed.has(d.id));
 return doc;
}
function projected(doc){
 const items=objects(doc),requested=doc.workspace?.selected;
 const selected=items.some(o=>o.id===requested)?requested:items.find(o=>o.datasetId===doc.inputs.datasets[doc.inputs.active||0]?.id)?.id||items[0]?.id||null;
 return {title:doc.title||'',objects:items,selected};
}

function commitView(session,view){
 const doc=clone(session);doc.title=view.title;doc.workspace={...doc.workspace,selected:view.selected};syncObjects(doc,view.objects);
 const owner=doc.inputs.datasets.findIndex(d=>d.id===view.selected||d.derivedFrom===view.selected||d.result?.objectId===view.selected||d.id+':fit'===view.selected);
 if(owner>=0)doc.inputs.active=owner;
 doc.inputs.active=Math.max(0,Math.min(doc.inputs.datasets.length-1,doc.inputs.active||0));
 const active=doc.inputs.datasets[doc.inputs.active];
 doc.results=active?.result?.response||null;doc.results_payload=active?.result?.payload||null;
 return doc;
}
function read(storage){const raw=storage.getItem(KEY);return raw?normalize(JSON.parse(raw)):empty();}
function write(storage,document,expected=document.revision){
 const previous=storage.getItem(KEY),revision=previous?JSON.parse(previous).revision||null:null;
 if(revision!==(expected||null))throw Error('This session was updated in another tab. Save your local changes to a JSON file, or reload the shared session before continuing.');
 const doc=normalize(document);doc.revision=id();doc.modified=new Date().toISOString();storage.setItem(KEY,JSON.stringify(doc));return doc;
}
function migrate(storage){
 const legacy=storage.getItem(LEGACY);let doc=read(storage);
 if(legacy){
  const old=JSON.parse(legacy).document;
  if(old?.objects?.length){
   const extra=fromOldAnalysis(old),ids=new Set(objects(doc).map(o=>o.id));
   for(const d of extra.inputs.datasets)if(!ids.has(d.id)&&!ids.has(d.result?.objectId))doc.inputs.datasets.push(d);
   for(const o of extra.objects)if(!ids.has(o.id))doc.objects.push(o);
   if(!doc.title)doc.title=old.title||'';doc.unsaved_changes=true;doc=write(storage,materialize(doc));
  }
  storage.removeItem(LEGACY);
 }
 return doc;
}
const api={KEY,empty,id,normalize,objects,usableObjects,projected,commitView,reconcileDatasets,materialize,measurementDataset,signature,read,write,migrate};
if(typeof module==='object')module.exports=api;else scope.WorkspaceStore=api;
})(globalThis);
