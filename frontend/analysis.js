(() => {
'use strict';
const $=id=>document.getElementById(id), C=AnalysisCore, E=RootEquation;
const S=WorkspaceStore, KEY=S.KEY, clone=v=>JSON.parse(JSON.stringify(v));
let session=S.empty(), doc=S.projected(session), history=[], view='table', editing=null, dirty=false;
let saved='', autoSaved=false, restoredDirty=false;
const uid=()=>crypto.randomUUID();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v===null||v===undefined?' - ':Number(v).toPrecision(6).replace(/(\.\d*?[1-9])0+(?=e|$)|\.0+(?=e|$)/g,'$1');
const current=()=>doc.objects.find(o=>o.id===doc.selected);
function resultText(r){
 if(r.uncertainty===null)return fmt(r.value)+' (uncertainty unspecified)';
 if(r.uncertainty===0)return fmt(r.value)+' ± 0';
 const places=1-Math.floor(Math.log10(r.uncertainty));
 if(places>=0&&places<=9)return r.value.toFixed(places)+' ± '+r.uncertainty.toFixed(places);
 return fmt(r.value)+' ± '+r.uncertainty.toPrecision(2);
}
const kinds={measurements:'Measurements',fit:'Fit result',values:'Quantities',calculation:'Calculation'};
function notify(text,error=false){$('notice').hidden=!text;$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function snapshot(value=session){return JSON.stringify({title:value.title,notes:value.notes,datasets:value.inputs.datasets,objects:value.objects});}
function persist(){
 autoSaved=false;
 try{
  const next=S.commitView(session,doc);dirty=restoredDirty||snapshot(next)!==saved;
  session=S.write(localStorage,{...next,unsaved_changes:dirty});doc=S.projected(session);autoSaved=true;
 }catch(e){dirty=true;notify(e.message+' Use Save to keep all local work in one file.',true);}
 $('save-state').textContent=dirty?'Unsaved changes':doc.objects.length?'Saved':'No data';
}
function change(fn){const previous=doc.selected;history.push(clone(session));if(history.length>25)history.shift();fn();if(previous!==doc.selected)view='table';persist();render();}
function calculationEngine(objects=doc.objects){return C.engine(objects.filter(o=>!o.incomplete));}
function select(id){doc.selected=id;view='table';persist();render();}
function table(headers,rows){return '<div class="table-scroll"><table><thead><tr>'+headers.map(x=>'<th scope="col">'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
function dependants(id){const found=new Set();let changed=true;while(changed){changed=false;for(const o of doc.objects)if(o.kind==='calculation'&&!found.has(o.id)&&(o.ownerDatasetId===id||found.has(o.ownerDatasetId)||Object.values(o.bindings||{}).some(b=>b.id===id||found.has(b.id)))){found.add(o.id);changed=true;}}return found;}
function sourceIds(o){return [...new Set(Object.values(o.bindings||{}).map(b=>b.id).filter(Boolean))];}
function sourceDataset(o,seen=new Set()){
 if(!o||seen.has(o.id))return null;
 const direct=session.inputs.datasets.find(d=>d.id===o.ownerDatasetId||d.id===o.datasetId||d.id===o.id||d.derivedFrom===o.id);
 if(direct)return direct;
 seen=new Set(seen).add(o.id);
 const parents=sourceIds(o).map(id=>sourceDataset(doc.objects.find(x=>x.id===id),seen));
 return parents.length&&parents.every(d=>d&&d.id===parents[0]?.id)?parents[0]:null;
}
function render(){
 $('analysis-title').value=doc.title;$('undo').disabled=!history.length;
 const o=current(),owner=sourceDataset(o);
 const standalone=doc.objects.filter(o=>!sourceDataset(o));
 const item=(o,label)=>`<button class="source-item" data-select="${esc(o.id)}" aria-current="${o.id===doc.selected}">${esc(label)}</button>`;
 $('object-list').innerHTML=session.inputs.datasets.filter(d=>d.analysis_type).map(d=>{
  const raw=doc.objects.find(x=>x.id===(d.derivedFrom||d.id));
  return raw?`<button class="source-item dataset-item" data-select="${esc(owner?.id===d.id?o.id:raw.id)}" aria-current="${owner?.id===d.id}"><strong>${esc(d.name)}</strong></button>`:'';
 }).join('')+(standalone.length?'<h3 class="quantities-heading">Quantities and calculations</h3>'+standalone.map(o=>item(o,o.name)).join(''):'');
 $('empty').hidden=!!o;$('object-content').hidden=!o;
 $('dataset-views').hidden=!owner;
 $('dataset-views').innerHTML=owner?[
  doc.objects.find(x=>x.id===(owner.derivedFrom||owner.id)),
  doc.objects.find(x=>x.kind==='fit'&&x.datasetId===owner.id&&!x.incomplete&&x.parameters?.length)
 ].map((x,i)=>`<button data-select="${esc(x?.id||'')}" aria-pressed="${x?.id===o.id}" ${x?'':'data-needs-fit="true" aria-haspopup="dialog"'}>${i?'Fit results':owner.derivedFrom?'Calculated data':'Raw data'}</button>`).join(''):'';
 $('dataset-calculations').hidden=!owner;
 const linked=owner?doc.objects.filter(x=>x.kind==='calculation'&&x.id!==owner.derivedFrom&&sourceDataset(x)?.id===owner.id):[];
 $('dataset-calculations').innerHTML=linked.length?'<span>Calculations</span>'+linked.map(x=>`<button data-select="${esc(x.id)}" aria-pressed="${x.id===o.id}">${esc(x.name)}</button>`).join(''):'';
 for(const id of ['calculate','export','delete'])$(id).disabled=!o;
 $('delete').textContent=o?({measurements:'Delete dataset',fit:'Delete fit results',calculation:'Delete calculation',values:'Delete quantities'}[o.kind]||'Delete'):'Delete';
 $('plot-selected').disabled=!o || !session.inputs.datasets.some(d=>d.id===o.datasetId||d.id===o.id||d.derivedFrom===o.id);
 $('edit-calculation').hidden=o?.kind!=='calculation';$('edit-source').hidden=!o||!['measurements','values'].includes(o.kind);
 $('edit-exclusions').hidden=!(owner?.analysis_type==='xy'&&o?.kind==='measurements');
 $('edit-data-heading').hidden=$('edit-source').hidden&&$('edit-exclusions').hidden;
 $('edit-exclusions').textContent='Point exclusions'+(owner?.exclusions?.length?' ('+owner.exclusions.length+')':'')+'…';
 $('relationships').innerHTML='';if(!o)return;
 $('object-title').textContent=owner?.name||o.name;$('object-kind').textContent=owner?(o.kind==='calculation'?'Dataset · Calculation: '+o.name:o.kind==='fit'?'Dataset · Fit results':owner.derivedFrom?'Dataset · Calculated data':'Dataset · Raw data'):kinds[o.kind];
 const views=['table'];let multiple=o.kind==='measurements';try{if(o.kind==='calculation')multiple=calculationEngine().get(o.id).length>1;}catch{} if(multiple)views.push('plot','statistics');if(o.kind==='fit'||o.kind==='values')views.push('covariance','correlation');if(o.kind==='fit'&&session.inputs.datasets.find(d=>d.id===o.datasetId)?.result?.response?.canvas_json)views.push('fitted plot');
 if(!views.includes(view))view='table';
 $('views').innerHTML=views.map(v=>`<button data-view="${v}" aria-pressed="${view===v}">${v==='table'&&!multiple?'Values':v[0].toUpperCase()+v.slice(1)}</button>`).join('');
 const links=ids=>ids.map(id=>{const s=doc.objects.find(x=>x.id===id);return `<div><button class="source-link" data-select="${esc(id)}">${esc(s?.name||'Missing source')}</button></div>`;}).join('');
 const parents=sourceIds(o), children=[...dependants(o.id)];
 $('relationships').innerHTML='<h3>Sources</h3>'+(parents.length?links(parents):'<p>'+esc(o.origin||'Entered measurements or quantities')+'</p>')+(children.length?'<h3>Used by</h3>'+links(children):'');
 if(o.kind==='fit')$('relationships').innerHTML+=(o.stale?'<p class="form-error">The source data or model has changed since this fit. Refit before calculating from these parameters.</p>':'')+'<h3>Fit model</h3><p>'+esc(o.formula||'Imported fit')+'</p><p>'+esc(o.converged===false?'Fit did not converge. Interpret derived results with caution.':'Parameters and covariance from this dataset’s latest fit.')+'</p>';
 try{renderRepresentation(o);}catch(e){$('representation').innerHTML='<p class="form-error">'+esc(e.message)+'</p>';}
}
function dataFor(o){if(o.incomplete)throw Error('This dataset is incomplete or has no fitted parameters. Open it in the plotting workspace to finish entering data or run a fit.');const engine=calculationEngine();return C.fields(o).map(f=>({...f,rows:engine.get(o.id,f.key)}));}
function renderRepresentation(o){
 const target=$('representation');
 if(view==='fitted plot'){drawFitCanvas(o);return;}
 const cols=dataFor(o);
 if(o.kind==='measurements'){const engine=calculationEngine();for(const calc of doc.objects.filter(c=>c.kind==='calculation'&&c.resultMode==='column'&&sourceDataset(c)?.id===o.datasetId)){try{const rows=engine.get(calc.id);if(rows.length===cols[0].rows.length)cols.push({name:calc.name,unit:calc.unit,rows});}catch{}}}
 if(view==='covariance'||view==='correlation'){
  const matrix=C.covariance(o.parameters,o.covariance),names=o.parameters.map(p=>p.name);
  const rows=matrix.map((row,i)=>[names[i],...row.map((v,j)=>fmt(view==='correlation'?(matrix[i][i]&&matrix[j][j]?v/Math.sqrt(matrix[i][i]*matrix[j][j]):null):v))]);
  target.innerHTML=table([view==='correlation'?'Correlation':'Covariance',...names],rows)+'<p class="note">'+(view==='correlation'?'Dimensionless correlation coefficients. Zero-variance quantities have undefined correlations.':'Covariance entries have the product of the row and column units. '+(o.covariance?'Imported full covariance matrix.':'Entered quantities are treated as independent.'))+'</p>';return;
 }
 if(view==='statistics'){
  target.innerHTML=table(['Column','n','Mean','Sample SD','Standard error','Unit'],cols.map(c=>{const s=C.stats(c.rows.map(r=>r.value));return[c.name,s.n,fmt(s.mean),fmt(s.sd),fmt(s.sem),c.unit];}))+'<p class="note">Unweighted statistics of the displayed values. Sample SD uses n − 1; standard error is SD / √n and assumes independent observations. Propagated measurement uncertainties are not used in these summaries.</p>';return;
 }
 if(view==='plot'){
  target.innerHTML='<div class="plot-controls"><label>Horizontal axis<select id="plot-x"><option value="index">Row number</option>'+cols.map((c,i)=>`<option value="${i}">${esc(c.name)}</option>`).join('')+'</select></label><label>Vertical axis<select id="plot-y">'+cols.map((c,i)=>`<option value="${i}">${esc(c.name)}</option>`).join('')+'</select></label></div><div id="scatter"></div><p class="note">X and Y values are paired by row. Error bars show available standard uncertainties. Use Make a Plot for model fitting.</p>';
  if(cols.length>1){$('plot-x').value='0';$('plot-y').value='1';}
  const draw=()=>scatter(cols);$('plot-x').onchange=draw;$('plot-y').onchange=draw;draw();return;
 }
 if(o.kind==='fit'||o.kind==='values')target.innerHTML=table(['Quantity','Value','Standard uncertainty','Unit'],cols.map(c=>[c.name,fmt(c.rows[0].value),fmt(c.rows[0].uncertainty),c.unit]));
 else if(o.kind==='calculation'&&cols[0].rows.length===1){const r=cols[0].rows[0];target.innerHTML=`<math-field class="formula-display" read-only>${esc(o.expression)}</math-field><p class="result-value">${resultText(r)} ${esc(o.unit)}</p>`+bindingTable(o)+`<details><summary>Numerical values</summary>${table(['Value','Standard uncertainty'],[[r.value,r.uncertainty]])}</details>`;}
 else {
  const excluded=o.kind==='measurements'?(session.inputs.datasets.find(d=>d.id===o.datasetId)?.exclusions||[]):[];
  const rows=cols[0].rows.map((_,i)=>{const p=excluded.find(p=>p.index===i&&p.x===cols[0].rows[i].value&&p.y===cols[1]?.rows[i].value);return[i+1,...cols.flatMap(c=>[fmt(c.rows[i].value),fmt(c.rows[i].uncertainty)]),...(excluded.length?[p?'Excluded':'Included',p?.reason||'']:[])];});
  target.innerHTML=(o.kind==='calculation'?'<math-field class="formula-display" read-only>'+esc(o.expression)+'</math-field>':'')+table(['Row',...cols.flatMap(c=>[c.name+(c.unit?' ('+c.unit+')':''),'u('+c.name+')']),...(excluded.length?['Fit inclusion','Reason']:[])],rows);
 }
 target.innerHTML+='<p class="note">'+(o.kind==='calculation'?'Standard uncertainty from first-order numerical propagation, retaining source covariance and shared inputs. '+(o.unitMode==='checked'?'Units and dimensions are checked.':'Legacy calculation: units were labels only. Edit this calculation to assign units and enable conversion.'):o.kind==='fit'?'Parameter uncertainties are obtained from the covariance diagonal.':'Uncertainties are standard uncertainties; entered columns and quantities are treated as independent.')+' A dash denotes an unspecified uncertainty.</p>';
}
let rootLoader=null,rootPainter=null;
async function drawFitCanvas(o){
 const host=document.createElement('div');host.className='fit-canvas';host.style.height='500px';$('representation').replaceChildren(host);
 host.textContent='Loading saved plot…';
 try{
  if(!window.JSROOT){
   if(!rootLoader)rootLoader=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://root.cern/js/latest/build/jsroot.min.js';script.onload=resolve;script.onerror=()=>{rootLoader=null;reject(Error('The plot renderer could not load. Your fit results remain available in Values.'));};document.head.append(script);});
   await rootLoader;
  }
  if(!host.isConnected)return;
  const r=session.inputs.datasets.find(d=>d.id===o.datasetId)?.result?.response;
  if(!r?.canvas_json)throw Error('No saved canvas is available for this fit.');
  host.textContent='';const root=window.JSROOT;root.settings.PreferSavedPoints=true;
  if(rootPainter){try{rootPainter.cleanup();}catch{}}
  rootPainter=await root.draw(host,root.parse(JSON.stringify(r.canvas_json)),'');root.registerForResize(rootPainter);
 }catch(e){if(host.isConnected)host.textContent=e.message;}
}
function bindingTable(o){return table(['Symbol','Source','Quantity'],Object.entries(o.bindings).map(([s,b])=>{const source=doc.objects.find(x=>x.id===b.id);return b.literal?[E.symbolLabel(s),'Entered value',b.value+' ± '+b.error+(b.unit?' '+b.unit:'')]:[E.symbolLabel(s),source?.name||'Missing source',source?(C.fields(source).find(f=>f.key===b.key)?.name||'')+(b.unit?' ['+b.unit+']':''):''];}));}
function scatter(cols){
 const xc=$('plot-x').value, y=cols[+$('plot-y').value], x=xc==='index'?{name:'Row number',unit:'',rows:y.rows.map((_,i)=>({value:i+1,uncertainty:0}))}:cols[+xc];
 const all=(c)=>c.rows.flatMap(r=>[r.value-(r.uncertainty||0),r.value+(r.uncertainty||0)]);
 const limits=c=>{const v=all(c);let lo=Math.min(...v),hi=Math.max(...v),pad=(hi-lo)*.08||Math.abs(lo)*.08||1;return[lo-pad,hi+pad];};
 const [xmin,xmax]=limits(x),[ymin,ymax]=limits(y),sx=v=>80+(v-xmin)/(xmax-xmin)*580,sy=v=>330-(v-ymin)/(ymax-ymin)*290;
 let svg='<svg class="plot-view" viewBox="0 0 720 410" role="img" aria-label="Scatter plot of '+esc(y.name)+' against '+esc(x.name)+'"><rect x="80" y="40" width="580" height="290" fill="white" stroke="#cbd6e1"/>';
 for(let i=0;i<=4;i++){const xx=xmin+(xmax-xmin)*i/4,yy=ymin+(ymax-ymin)*i/4;svg+=`<text x="${sx(xx)}" y="354" text-anchor="middle" font-size="12">${esc(fmt(xx))}</text><text x="70" y="${sy(yy)+4}" text-anchor="end" font-size="12">${esc(fmt(yy))}</text>`;}
 y.rows.forEach((r,i)=>{const a=x.rows[i],px=sx(a.value),py=sy(r.value);svg+=`<path d="M ${sx(a.value-(a.uncertainty||0))} ${py} H ${sx(a.value+(a.uncertainty||0))} M ${px} ${sy(r.value-(r.uncertainty||0))} V ${sy(r.value+(r.uncertainty||0))}" stroke="#346295"/><circle cx="${px}" cy="${py}" r="3" fill="#346295"/>`;});
 svg+=`<text x="370" y="392" text-anchor="middle" font-size="14">${esc(x.name)}${x.unit?' ('+esc(x.unit)+')':''}</text><text transform="translate(18 185) rotate(-90)" text-anchor="middle" font-size="14">${esc(y.name)}${y.unit?' ('+esc(y.unit)+')':''}</text></svg>`;$('scatter').innerHTML=svg;
}
function ask(title,message,value=null,accept='Continue'){
 return new Promise(resolve=>{
  const d=$('prompt-dialog');$('prompt-title').textContent=title;$('prompt-message').textContent=message;$('prompt-label').hidden=value===null;$('prompt-input').value=value??'';$('prompt-accept').textContent=accept;
  const finish=v=>{d.oncancel=null;$('prompt-form').onsubmit=null;$('prompt-cancel').onclick=null;d.close();resolve(v);};
  $('prompt-form').onsubmit=e=>{e.preventDefault();finish(value===null?true:$('prompt-input').value);};$('prompt-cancel').onclick=()=>finish(null);d.oncancel=e=>{e.preventDefault();finish(null);};d.showModal();(value===null?$('prompt-accept'):$('prompt-input')).focus();
 });
}
function helpSource(){const quantities=$('source-type').value==='values';$('paste-help').textContent=quantities?'One quantity per row: name, value, standard uncertainty, unit (optional). Separate fields with tabs.':'First row: column names, optionally with units in brackets (e.g. Voltage [V]). Add uncertainty columns named u(Voltage). Remaining rows contain numeric values.';$('source-text').placeholder=quantities?'Resistance\t100\t2\tΩ\nCurrent\t0.02\t0.001\tA':'Time [s]\tVoltage [V]\tu(Voltage)\n0\t2.4\t0.1\n1\t1.8\t0.1';}
function sourceDialog(edit=false){editing=edit?current().id:null;const o=current();$('source-heading').textContent=edit?'Edit source data':'Add data';$('source-form').querySelector('[type=submit]').textContent=edit?'Apply changes':'Add data';$('source-name').value=edit?o.name:'';$('source-type').value=edit?o.kind:'measurements';$('source-type').disabled=edit;$('source-error').textContent='';
 if(edit&&o.kind==='values')$('source-text').value=o.parameters.map(p=>[p.name,p.value,p.error,p.unit].join('\t')).join('\n');
 else if(edit){const head=o.columns.flatMap(c=>[c.name+(c.unit?' ['+c.unit+']':''),...(c.errors?['u('+c.name+')']:[])]);$('source-text').value=[head.join('\t'),...o.columns[0].values.map((_,i)=>o.columns.flatMap(c=>[c.values[i],...(c.errors?[c.errors[i]]:[])]).join('\t'))].join('\n');}
 else $('source-text').value='';helpSource();$('source-dialog').showModal();}
const number=s=>{if(!String(s??'').trim()||!Number.isFinite(Number(s)))throw Error('Every value must be a finite number.');return Number(s);};
function parseSource(){
 const lines=$('source-text').value.trim().split(/\r?\n/).map(l=>l.split('\t').map(x=>x.trim())),kind=$('source-type').value;
 const o={...(editing?clone(current()):{}),id:editing||uid(),name:$('source-name').value.trim(),kind};delete o.incomplete;if(!o.name)throw Error('Enter a name.');
 if(kind==='values')o.parameters=lines.map(r=>({name:r[0],value:number(r[1]),error:number(r[2]),unit:r[3]||''}));
 else {
  const headers=lines.shift(), names=headers.map(h=>h.replace(/\s*\[[^\]]*\]\s*$/,'').trim());
  if(new Set(names).size!==names.length||names.some(n=>!n))throw Error('Column names must be nonempty and unique.');
  if(lines.some(r=>r.length!==headers.length))throw Error('Each row must contain the same number of tab-separated fields as the header.');
  for(const n of names.filter(n=>/^u\(.+\)$/.test(n)))if(!names.includes(n.slice(2,-1)))throw Error('Uncertainty column '+n+' has no matching measurement column.');
  o.columns=headers.flatMap((h,i)=>{if(/^u\(.+\)$/.test(names[i]))return[];const errorIndex=names.indexOf('u('+names[i]+')');return[{name:names[i],unit:h.match(/\[([^\]]*)\]\s*$/)?.[1]||'',values:lines.map(r=>number(r[i])),...(errorIndex>=0?{errors:lines.map(r=>number(r[errorIndex]))}:{})}];});
 }
 C.engine([o]);
 if(editing&&dependants(editing).size){const old=doc.objects.find(x=>x.id===editing);if(JSON.stringify(C.fields(old).map(f=>f.name))!==JSON.stringify(C.fields(o).map(f=>f.name)))throw Error('Keep source column or quantity names and their order while calculations depend on them. Add a new source for a different structure.');}
 if(editing){const en=calculationEngine(doc.objects.map(x=>x.id===editing?o:x));for(const id of dependants(editing))en.get(id);}
 return o;
}
function sourceOptions(exclude){
 const blocked=exclude?dependants(exclude):new Set();
 return doc.objects.filter(o=>o.id!==exclude&&!blocked.has(o.id)&&sourceDataset(o)?.id===calculationDatasetId).flatMap(o=>C.fields(o).map(f=>{
  const owner=sourceDataset(o),type=o.kind==='fit'?'Fit parameters':o.kind==='measurements'?'Measurement columns':o.kind==='calculation'?'Calculated quantities':'Entered quantities';
  const group=(owner?.name||o.name)+' - '+type;
  const p=o.kind==='fit'?o.parameters[Number(f.key)]:null;
  const name=p?(/^(?:p)?\d+$/.test(f.name)?'Parameter ['+f.key+']':f.name+' ['+f.key+']'):f.name;
  const detail=p?fmt(p.value)+' ± '+fmt(p.error)+(f.unit?' '+f.unit:''):
    o.kind==='measurements'?o.columns[Number(f.key)].values.length+' values'+(f.unit?' · '+f.unit:''):f.unit;
  return {value:JSON.stringify({id:o.id,key:f.key}),label:group+' / '+name+(f.unit?' ['+f.unit+']':''),name,detail,group,formula:o.kind==='fit'?o.formula:'',unavailable:o.incomplete?'No values available':o.stale?'Refit after changing the data or model':null};
 }));
}
function renderCalculationSources(){
 const groups=new Map();
 for(const option of sourceOptions(editing)){if(!groups.has(option.group))groups.set(option.group,[]);groups.get(option.group).push(option);}
 $('calculation-sources').innerHTML=[...groups].map(([name,options])=>'<section class="quantity-group"><h4>'+esc(name)+'</h4>'+(options[0].formula?'<p class="quantity-formula">Fit function: <code>'+esc(options[0].formula)+'</code></p>':'')+'<div class="quantity-buttons">'+options.map(s=>`<button type="button" data-source="${esc(s.value)}" ${s.unavailable?'disabled':''}><strong>${esc(s.name)}</strong><small>${esc(s.unavailable||s.detail)}</small></button>`).join('')+'</div></section>').join('');
}

let bindings={},previewTimer,calculationDatasetId=null;
function readBindings(){
 const result={};
 document.querySelectorAll('[data-binding]').forEach(select=>{
  const symbol=select.dataset.binding;if(!select.value)return;
  if(select.value==='literal'){
   const box=select.closest('.binding-entry'),value=box.querySelector('[data-value]').value,error=box.querySelector('[data-error]').value;
   result[symbol]={literal:true,value:value.trim()===''?null:Number(value),error:error.trim()===''?null:Number(error),unit:box.querySelector('[data-unit]').value};
  }else {const source=JSON.parse(select.value),unit=select.closest('.binding-entry').querySelector('[data-source-unit]').value.trim();result[symbol]={...source,unit};}
 });return result;
}
function buildBindings(){
 const previous={...bindings,...readBindings()};bindings=previous;
 try{
  if(!$('calculation-expression').value.trim()){$('bindings').innerHTML='';$('calculation-error').textContent='';$('calculation-preview').textContent='Enter an expression to preview the result.';return;}
  const expr=E.expression($('calculation-expression').value),options=sourceOptions(editing).filter(s=>!s.unavailable);
  $('bindings').innerHTML=expr.variables.map(symbol=>{
   const prior=previous[symbol],label=esc(E.symbolLabel(symbol));
   const source=doc.objects.find(o=>o.id===prior?.id),sourceUnit=source?C.fields(source).find(f=>f.key===String(prior?.key))?.unit||'':'';
   return `<div class="binding-entry"><label class="binding"><span>${label}</span><select data-binding="${esc(symbol)}"><option value="">Choose a source…</option><option value="literal" ${prior?.literal?'selected':''}>Enter a value…</option>${options.map(o=>`<option value="${esc(o.value)}" ${JSON.stringify(prior&&{id:prior.id,key:prior.key})===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select></label><label class="source-unit-field" ${!prior||prior.literal?'hidden':''}>Source unit<input data-source-unit aria-label="${label} source unit" placeholder="e.g. mm^-1; 1 for dimensionless" value="${esc(sourceUnit||prior?.unit||'')}" ${sourceUnit?'readonly':''}></label><div class="literal-fields" ${prior?.literal?'':'hidden'}><label>Value<input data-value aria-label="${label} value" type="text" inputmode="decimal" value="${esc(prior?.value??'')}"></label><label>Standard uncertainty<input data-error aria-label="${label} standard uncertainty" type="text" inputmode="decimal" value="${esc(prior?.error??'')}"></label><label>Unit<input data-unit aria-label="${label} unit" value="${esc(prior?.unit||'')}"></label><p class="note">Enter 0 for an exact constant. Units are converted automatically; enter 1 for dimensionless quantities.</p></div></div>`;
  }).join('');
  $('calculation-error').textContent='';preview();
 }catch(e){$('bindings').innerHTML='';$('calculation-preview').textContent='';$('calculation-error').textContent=e.message.replace(/before fitting/g,'before calculating');}
}
function calculation(){
 const b=readBindings();
 for(const [symbol,binding] of Object.entries(b))if(!binding.literal&&sourceDataset(doc.objects.find(o=>o.id===binding.id))?.id!==calculationDatasetId)throw Error('Choose a source from the selected dataset for '+symbol+'.');
 return {id:editing||'preview',kind:'calculation',unitMode:'checked',ownerDatasetId:calculationDatasetId,resultMode:$('calculation-kind').value,name:$('calculation-name').value.trim()||'Calculated quantity',unit:$('calculation-unit').value.trim(),expression:$('calculation-expression').value,bindings:b};
}
function preview(){
 try{const o=calculation(),objects=doc.objects.filter(x=>x.id!==editing).concat(o),result=calculationEngine(objects).get(o.id);$('calculation-preview').innerHTML=result.length===1?esc(resultText(result[0])+' '+o.unit):table(['Row','Value','Standard uncertainty'],result.slice(0,10).map((r,i)=>[i+1,fmt(r.value),fmt(r.uncertainty)]))+'<p class="note">'+result.length+' rows'+(result.length>10?'; showing the first 10':'')+'.</p>';$('calculation-error').textContent='';}
 catch(e){$('calculation-preview').textContent='';$('calculation-error').textContent=e.message.replace(/before fitting/g,'before calculating');}
}
function closeCalculation(){
 clearTimeout(previewTimer);$('calculation-page').hidden=true;
 document.querySelector('.analysis-workspace').hidden=false;document.querySelector('.toolbar').hidden=false;
 historyReplace('');$('calculate').focus();window.scrollTo(0,0);
}
function historyReplace(hash){window.history.replaceState(null,'',window.location.pathname+window.location.search+hash);}
function calculationDialog(edit=false){
 const owner=sourceDataset(current());
 if(!owner){notify('Select a dataset before creating or editing a calculation.',true);return;}
 calculationDatasetId=owner.id;
 $('calculation-heading').textContent=(edit?'Edit calculation':'Calculate quantity or column')+' - '+owner.name;
 $('calculation-form').querySelector('[type=submit]').textContent=edit?'Save changes':'Save calculation';
 editing=edit?current().id:null;const o=edit?current():null;bindings=clone(o?.bindings||{});
 let mode=o?.resultMode||'quantity';
 if(o&&!o.resultMode){try{if(calculationEngine().get(o.id).length>1)mode='column';}catch{}}
 $('calculation-kind').value=mode;
 $('calculation-name').value=o?.name||'';$('calculation-unit').value=o?.unit||'';
 $('calculation-expression').setValue(o?.expression||'',{silenceNotifications:true});
 $('bindings').innerHTML='';$('calculation-error').textContent='';$('calculation-preview').textContent='Enter an expression to preview the result.';
 renderCalculationSources();
 document.querySelector('.analysis-workspace').hidden=true;document.querySelector('.toolbar').hidden=true;
 $('calculation-page').hidden=false;historyReplace('#calculate');window.scrollTo(0,0);$('calculation-page').focus();if(o)buildBindings();
}
$('cancel-calculation').onclick=closeCalculation;
$('calculation-sources').onclick=e=>{
 const button=e.target.closest('[data-source]');if(!button||button.disabled)return;
 const source=JSON.parse(button.dataset.source);
 let symbol=Object.keys(bindings).find(k=>JSON.stringify(bindings[k])===JSON.stringify(source));
 if(!symbol){let index=1;while(bindings['q_'+index])index++;symbol='q_'+index;bindings[symbol]=source;}
 const field=$('calculation-expression');field.focus();field.insert(symbol.replace(/_(\d+)$/, '_{$1}'));buildBindings();
};

function download(text,name,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function example(){const id=uid(),q=uid();return[{id,kind:'fit',name:'Decay fit',origin:'Illustrative fit parameters',formula:'[0]*exp(-x/[1])',parameters:[{name:'Amplitude',value:100,error:4,unit:'counts'},{name:'Lifetime',value:2.4,error:.08,unit:'s'}],covariance:[[16,-.12],[-.12,.0064]]},{id:q,kind:'calculation',name:'Half-life',expression:'t\\ln(2)',unit:'s',bindings:{t:{id,key:'1'}}}];}
$('dataset-views').onclick=async e=>{
 const b=e.target.closest('[data-select]');if(!b)return;
 if(b.dataset.needsFit){
  if(await ask('No fit results yet','This dataset has no fit results. Open Make a Plot to select a fit function and run a fit. Your data will remain selected.',null,'Open Make a Plot'))$('plot-selected').click();
 }else select(b.dataset.select);
};
$('dataset-calculations').onclick=e=>{const b=e.target.closest('[data-select]');if(b)select(b.dataset.select);};
$('object-list').onclick=e=>{const b=e.target.closest('[data-select]');if(b)select(b.dataset.select);};$('relationships').onclick=e=>{const b=e.target.closest('[data-select]');if(b)select(b.dataset.select);};
$('views').onclick=e=>{const b=e.target.closest('[data-view]');if(b){view=b.dataset.view;render();}};
$('analysis-title').oninput=()=>{doc.title=$('analysis-title').value;persist();};
$('edit-exclusions').onclick=()=>{
 const d=sourceDataset(current());if(!d||d.analysis_type!=='xy')return;
 const numbers=s=>String(s??'').trim().split(/[\s,;]+/).filter(Boolean).map(Number),x=numbers(d.x),y=numbers(d.y);
 if(!x.length||x.length!==y.length||[...x,...y].some(v=>!Number.isFinite(v))){notify('Enter matching numeric X and Y columns before excluding measurements.',true);return;}
 AnalysisFeatures.openExclusions(d,{values:x},{values:y},next=>{change(()=>{d.exclusions=next;});notify('Exclusions saved. Open in plotting and run Fit to update the results. Raw values and calculated columns are unchanged.');});
};
// --- shared Insert data grid (insert-data.js): full parity with Make a Plot ---
const DA_COLORS=['#000000','#d62728','#1f5fbf','#2a8f3c','#8e44ad','#e08a00','#17a2b8','#7f4f24'];
// Grid-editable: any typed, non-derived dataset except multi-column measurements (those use the text editor).
const editable=d=>!!d.analysis_type&&!d.derivedFrom&&!(d.analysis_type==='xy'&&d.measurementColumns&&d.measurementColumns.length>2);
const editableDatasets=()=>session.inputs.datasets.filter(editable);
const isEmptyDs=d=>{
 if(d.analysis_type==='histogram'){const h=d.histogram||{};return !String(h.samples||'').trim()&&!String(h.counts||'').trim();}
 if(d.analysis_type==='multivariate'){const mv=d.mv;return !mv||!(mv.inVals||[]).some(v=>String(v).trim());}
 return !String(d.x||'').trim()&&!String(d.y||'').trim();
};
let daActive=0,daSeed=null;
// Write edited datasets straight into the session (preserving histogram/mv/fit) and drop orphaned dependents.
function commitDatasets(merged,selectId){
 autoSaved=false;
 try{
  const next=S.reconcileDatasets(session,merged);next.title=doc.title;
  dirty=restoredDirty||snapshot(next)!==saved;
  session=S.write(localStorage,{...next,unsaved_changes:dirty});doc=S.projected(session);autoSaved=true;
  if(selectId){const o=doc.objects.find(x=>x.datasetId===selectId||x.id===selectId);if(o)doc.selected=o.id;}
 }catch(e){dirty=true;notify(e.message+' Use Save to keep all local work in one file.',true);}
 $('save-state').textContent=dirty?'Unsaved changes':doc.objects.length?'Saved':'No data';
 render();
}
const insertHost={
 fitSettings:true,addLabel:'New dataset',types:['xy','histogram','multivariate'],
 datasets:()=>{const list=editableDatasets();return list.length?list:[daSeed];},
 activeIndex:()=>daActive,
 color:i=>DA_COLORS[i%DA_COLORS.length],
 newDataset:(name,type)=>{const t=type||'xy';const fit={formula:'[0]*x+[1]',param_names:'',initial_guesses:'',x_min:'',x_max:''};if(t==='histogram')Object.assign(fit,{formula:'gausn',param_names:'norm, mean, sigma'});const d={id:S.id(),name,analysis_type:t,x:'',y:'',ex:'',ey:'',fit};if(t==='multivariate'&&window.Multivariate)d.mv=window.Multivariate.defaultMv();return d;},
 requestName:cur=>ask('Rename dataset','',cur,'Rename'),
 confirmDelete:(name,n)=>ask('Delete dataset','Delete “'+name+'” from the shared session? Dependent calculations are removed too.'),
 message:(kind,text)=>notify(text,kind==='error'),
 newName:sug=>ask('New dataset','',sug,'Create'),
 commit:({datasets:edited,activeIndex})=>{
  const byId=new Map(edited.map(d=>[d.id,d])),used=new Set(),merged=[];
  for(const d of session.inputs.datasets){
   if(editable(d)){const e=byId.get(d.id);if(e){merged.push(e);used.add(e.id);}}
   else merged.push(d);
  }
  for(const e of edited)if(!used.has(e.id)&&!isEmptyDs(e))merged.push(e);
  const active=edited[Math.min(activeIndex,edited.length-1)];
  history.push(clone(session));if(history.length>25)history.shift();
  commitDatasets(merged,active&&active.id);
 },
};
function openInsertData(focusId){
 const list=editableDatasets();
 daSeed=list.length?null:insertHost.newDataset('Dataset 1','xy');
 const i=focusId?list.findIndex(d=>d.id===focusId):0;daActive=i>=0?i:0;
 window.InsertData.open(insertHost);
}
$('add-source').onclick=()=>openInsertData();
$('add-source-text').onclick=()=>sourceDialog();
$('edit-source').onclick=()=>{const o=current();const d=o&&sourceDataset(o);if(d&&editable(d)){openInsertData(d.id);return;}sourceDialog(true);};
$('source-type').onchange=helpSource;
$('source-form').onsubmit=e=>{e.preventDefault();try{const o=parseSource();change(()=>{const i=doc.objects.findIndex(x=>x.id===o.id);if(i<0)doc.objects.push(o);else doc.objects[i]=o;doc.selected=o.id;});$('source-dialog').close();}catch(e){$('source-error').textContent=e.message;}};
$('calculate').onclick=()=>{if(!window.MathfieldElement){notify('The equation editor could not load. Reload the page and try again.',true);return;}calculationDialog();};$('edit-calculation').onclick=()=>calculationDialog(true);
$('calculation-expression').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();}});
$('calculation-expression').addEventListener('input',()=>{clearTimeout(previewTimer);previewTimer=setTimeout(buildBindings,180);});$('bindings').onchange=e=>{if(e.target.matches('[data-binding]')){const box=e.target.closest('.binding-entry');box.querySelector('.literal-fields').hidden=e.target.value!=='literal';const field=box.querySelector('.source-unit-field'),input=box.querySelector('[data-source-unit]');field.hidden=!e.target.value||e.target.value==='literal';if(!field.hidden){const b=JSON.parse(e.target.value),source=doc.objects.find(o=>o.id===b.id),unit=C.fields(source).find(f=>f.key===String(b.key))?.unit||'';input.value=unit;input.readOnly=!!unit;}}bindings={...bindings,...readBindings()};preview();};$('bindings').oninput=e=>{if(!e.target.matches('select')){bindings={...bindings,...readBindings()};preview();}};$('calculation-unit').oninput=preview;
$('calculation-form').onsubmit=e=>{e.preventDefault();clearTimeout(previewTimer);buildBindings();try{const o=calculation();if(!o.name.trim())throw Error('Enter a name.');const en=calculationEngine(doc.objects.filter(x=>x.id!==editing).concat(o));const rows=en.get(o.id);if(o.resultMode==='quantity'&&rows.length>1)throw Error('This expression produces multiple rows. Select Calculated column as the result type.');if(o.resultMode==='column'&&!Object.values(o.bindings).some(b=>!b.literal&&en.get(b.id,b.key).length>1))throw Error('Bind at least one measurement column to calculate a value for each row.');if(!editing)o.id=uid();change(()=>{const i=doc.objects.findIndex(x=>x.id===o.id);if(i<0)doc.objects.push(o);else doc.objects[i]=o;doc.selected=o.id;});closeCalculation();}catch(e){$('calculation-error').textContent=e.message;}};
$('rename').onclick=async()=>{const o=current(),owner=session.inputs.datasets.find(d=>d.id===o.datasetId),raw=doc.objects.find(x=>x.id===(owner?.derivedFrom||o.datasetId))||o,name=await ask('Rename dataset or quantity','',raw.name,'Rename');if(name?.trim())change(()=>{raw.name=name.trim();});};
$('delete').onclick=async()=>{
 const o=current(),remove=new Set([o.id]);
 if(o.kind==='measurements'||o.kind==='calculation')for(const f of doc.objects)if(f.kind==='fit'&&(f.datasetId===o.id||session.inputs.datasets.some(d=>d.derivedFrom===o.id&&d.id===f.datasetId)))remove.add(f.id);
 for(const id of [...remove])for(const child of dependants(id))remove.add(child);
 if(await ask('Delete from session','Delete “'+o.name+'”'+(remove.size>1?' and '+(remove.size-1)+' associated result(s) or calculation(s)':'')+' from all workspaces?'))change(()=>{doc.objects=doc.objects.filter(x=>!remove.has(x.id));doc.selected=doc.objects[0]?.id||null;});
};
$('undo').onclick=()=>{if(history.length){const revision=session.revision;session=history.pop();session.revision=revision;doc=S.projected(session);persist();render();}};
$('plot-selected').onclick=()=>{persist();if(autoSaved){dirty=false;window.location.href='modern.html';}};
$('reload-session').onclick=async()=>{if(await ask('Reload shared session','Replace this page with the latest shared session? Save first if you need to keep local changes.')){session=S.read(localStorage);doc=S.projected(session);saved=snapshot();restoredDirty=session.unsaved_changes!==false;history=[];persist();render();notify('Shared session loaded.');}};
$('clear').onclick=async()=>{if(await ask('Clear analysis','Remove all datasets, fits, and calculations from every workspace? Saved files will not be changed.'))change(()=>{doc.objects=[];doc.selected=null;doc.title='';session.notes='';});};
$('example').onclick=async()=>{if(await ask('Load example analysis','Add an illustrative decay fit and a half-life calculation to this analysis?'))change(()=>{const objects=example();doc.objects.push(...objects);doc.selected=objects[1].id;});};
$('save').onclick=async()=>{
 const name=await ask('Save analysis','Save the sources, calculations, and their relationships.',doc.title||'analysis','Save');if(name===null)return;
 if(!name.trim()||/[\\/:*?"<>|]/.test(name)){notify('Choose a filename without slashes or reserved characters.',true);return;}
 let complete;try{complete=S.commitView(session,doc);}catch(e){notify(e.message,true);return;}
 const filename=name.trim().replace(/\.json$/i,'')+'.json',text=JSON.stringify(complete,null,2);
 try{
  if(window.showSaveFilePicker){const handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'Analysis document',accept:{'application/json':['.json']}}]});if((await handle.getFile()).size&& !await ask('Replace file','Replace the existing contents of “'+handle.name+'”?'))return;const stream=await handle.createWritable();await stream.write(text);await stream.close();}
  else{const key='gauss.analysis.downloads',names=JSON.parse(localStorage.getItem(key)||'[]');if(names.includes(filename)&&!await ask('Download another copy','A download with this name was already requested. Your browser will handle duplicate filenames.'))return;download(text,filename);try{localStorage.setItem(key,JSON.stringify([...new Set([...names,filename])].slice(-100)));}catch{}}
  saved=snapshot(complete);restoredDirty=false;persist();notify('Complete session saved or download requested: '+filename);
 }catch(e){if(e.name!=='AbortError')notify('The file could not be saved: '+e.message,true);}
};
$('open').onclick=()=>$('file').click();$('file').onchange=async()=>{
 const file=$('file').files[0];if(!file)return;
 try{
  if(file.size>50e6)throw Error('Choose a session file smaller than 50 MB.');
  const incoming=S.materialize(S.normalize(JSON.parse(await file.text())));
  if(doc.objects.length&&!await ask('Open session','Replace the current datasets, fits, and calculations in all workspaces? Save first if you want to keep them.'))return;
  history.push(clone(session));incoming.revision=S.read(localStorage).revision;session=incoming;doc=S.projected(session);saved=snapshot();restoredDirty=false;persist();render();notify('Loaded the complete session. It is also available in Compact and Standard.');
 }catch(e){notify(e.message,true);}finally{$('file').value='';}
};
$('export-analysis').onclick=()=>{persist();if(autoSaved)AnalysisExport.open(session);};
$('export').onclick=()=>{try{const o=current(),cols=dataFor(o),n=Math.max(...cols.map(c=>c.rows.length));const quote=x=>'"'+String(x??'').replace(/"/g,'""')+'"';const rows=[cols.flatMap(c=>[c.name+(c.unit?' ['+c.unit+']':''),'u('+c.name+')']),...Array.from({length:n},(_,i)=>cols.flatMap(c=>[c.rows[i]?.value,c.rows[i]?.uncertainty]))];download(rows.map(r=>r.map(quote).join(',')).join('\n'),o.name.replace(/[^\w -]/g,'_')+'.csv','text/csv');}catch(e){notify(e.message,true);}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
window.addEventListener('beforeunload',e=>{if(dirty||document.querySelector('dialog[open]')||!$('calculation-page').hidden){e.preventDefault();e.returnValue='';}});
document.querySelectorAll('.masthead a').forEach(a=>a.addEventListener('click',()=>{persist();if(autoSaved)dirty=false;}));
if(window.MathfieldElement){MathfieldElement.soundsDirectory=null;$('calculation-expression').mathVirtualKeyboardPolicy='manual';}
window.addEventListener('storage',event=>{
 if(event.key!==KEY)return;
 if(document.querySelector('dialog[open]')||!$('calculation-page').hidden){notify('The shared session changed in another tab. Finish or cancel this dialog, then use Reload session. Save local changes first if needed.',true);return;}
 try{session=S.read(localStorage);doc=S.projected(session);saved=snapshot();restoredDirty=session.unsaved_changes!==false;history=[];dirty=restoredDirty;render();$('save-state').textContent=dirty?'Unsaved changes':'Saved';notify('Updated from the shared session.');}catch(e){notify(e.message,true);}
});
try{session=S.migrate(localStorage);S.materialize(session);doc=S.projected(session);restoredDirty=session.unsaved_changes!==false&&doc.objects.length>0;saved=snapshot();}
catch(e){notify('The shared session could not be restored: '+e.message+' Open a saved JSON file to recover it.',true);}
persist();render();
})();
