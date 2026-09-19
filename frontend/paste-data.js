/* Spreadsheet paste parser shared by both plotting interfaces. */
(function(scope){
'use strict';
function parse(text,header='auto'){
 const separator=text.includes('\t')?'\t':text.includes(',')?',':null;
 const rows=[];let row=[],cell='',quoted=false;
 if(separator){
  for(let i=0;i<text.length;i++){
   const c=text[i];
   if(c==='"'&&(quoted||cell==='')){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
   else if(!quoted&&(c===separator||c==='\n')){row.push(cell.trim());cell='';if(c==='\n'){rows.push(row);row=[];}}
   else if(c!=='\r')cell+=c;
  }
  if(quoted)throw Error('A quoted cell is incomplete. Copy the full table and paste again.');
  row.push(cell.trim());rows.push(row);
 }else for(const line of text.split(/\r?\n/))rows.push(line.trim().split(/\s+/));
 while(rows.length&&rows.at(-1).every(c=>c===''))rows.pop();
 while(rows.length&&rows[0].every(c=>c===''))rows.shift();
 if(!rows.length)throw Error('Paste a table of measurements.');
 if(rows.length>10001||Math.max(...rows.map(r=>r.length))>50)throw Error('Paste at most 10,000 data rows and 50 columns.');
 const isHeader=header==='yes'||header==='auto'&&rows[0].every(c=>c===''||!Number.isFinite(Number(c)))&&rows[0].some(Boolean);
 const width=Math.max(...rows.map(r=>r.length));
 const headers=isHeader?rows.shift():Array.from({length:width},(_,i)=>'Column '+(i+1));
 return {headers:Array.from({length:width},(_,i)=>headers[i]||'Column '+(i+1)),rows,hasHeader:isHeader};
}
function defaults(table,type){
 if(type==='histogram')return table.headers.map((_,i)=>i===0?'samples':'');
 if(!table.hasHeader)return table.headers.map((_,i)=>['x','y','ey','ex'][i]||'');
 const names=table.headers.map(h=>h.replace(/\s*\[[^\]]*\]\s*$/,'').trim().toLowerCase());
 const err=n=>/^u\(.+\)$/.test(n)||/^(?:[xy]\s*(?:err(?:or)?s?|uncertainty)|[de][xy])$/.test(n);
 const ordinary=names.map((n,i)=>!err(n)?i:-1).filter(i=>i>=0);
 const x=names.indexOf('x')>=0?names.indexOf('x'):ordinary[0], y=names.indexOf('y')>=0?names.indexOf('y'):ordinary[1];
 return names.map((n,i)=>i===x?'x':i===y?'y':n==='u('+names[x]+')'||/^(?:x\s*(?:err(?:or)?s?|uncertainty)|[de]x)$/.test(n)?'ex':n==='u('+names[y]+')'||/^(?:y\s*(?:err(?:or)?s?|uncertainty)|[de]y)$/.test(n)?'ey':'');
}
function convert(table,mapping,type){
 if(!table.rows.length)throw Error('Add at least one measurement below the header.');
 const assigned=mapping.filter(Boolean);
 if(new Set(assigned).size!==assigned.length)throw Error('Assign each axis or uncertainty to only one column.');
 for(const required of type==='histogram'?['samples']:['x','y'])if(!assigned.includes(required))throw Error('Choose a column for '+(required==='samples'?'measurements':required.toUpperCase())+'.');
 const out={x:[],y:[],ex:[],ey:[],samples:[]};
 table.rows.forEach((r,i)=>mapping.forEach((target,c)=>{
  if(!target)return;const value=r[c]??'';
  if(!value.trim()||!Number.isFinite(Number(value)))throw Error('Row '+(i+1+(table.hasHeader?1:0))+', '+table.headers[c]+': enter a finite number. Empty cells are not skipped.');
  if(['ex','ey'].includes(target)&&Number(value)<0)throw Error('Row '+(i+1)+': uncertainties must be nonnegative.');
  out[target].push(value);
 }));
 return Object.fromEntries(Object.entries(out).map(([k,a])=>[k,a.join('\n')]));
}
const api={parse,defaults,convert};if(typeof module==='object'){module.exports=api;return;}scope.PlotPaste=api;
const $=id=>document.getElementById(id),escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dialog=document.createElement('dialog');dialog.id='spreadsheet-dialog';dialog.className='tframe';dialog.setAttribute('aria-labelledby','spreadsheet-title');
dialog.innerHTML=`<div class="titlebar" id="spreadsheet-title">Paste spreadsheet data</div><form id="spreadsheet-form" class="dialog-body">
<div class="spreadsheet-options"><div class="field"><label for="spreadsheet-name">Dataset name</label><input id="spreadsheet-name" type="text" maxlength="120" required></div><div class="field"><label for="spreadsheet-type">Analysis type</label><select id="spreadsheet-type"><option value="xy">XY data</option><option value="histogram">Histogram measurements</option></select></div></div>
<div class="field"><label for="spreadsheet-text">Data</label><textarea id="spreadsheet-text" rows="5" class="mono" spellcheck="false" placeholder="Time [s]&#9;Voltage [V]&#9;u(Voltage)&#10;0&#9;2.4&#9;0.1&#10;1&#9;1.8&#9;0.1"></textarea></div>
<p class="hint">Copy columns from Excel or another spreadsheet, including headers if available. Assign the columns below; uncertainty columns are optional.</p>
<div class="spreadsheet-options"><div class="field"><label for="spreadsheet-header">First row</label><select id="spreadsheet-header"><option value="auto">Detect header automatically</option><option value="yes">Column headers</option><option value="no">Measurements</option></select></div><div class="field"><label for="spreadsheet-destination">Load into</label><select id="spreadsheet-destination"><option value="new">New dataset</option><option value="replace">Replace selected dataset</option></select></div></div>
<div id="spreadsheet-preview"></div><p id="spreadsheet-error" class="spreadsheet-error" role="alert"></p>
<div class="row actions"><button type="button" id="spreadsheet-cancel">Cancel</button><button type="submit" class="primary">Load data</button></div></form>`;
document.body.append(dialog);
let table=null;
function preview(){
 $('spreadsheet-error').textContent='';table=null;
 try{
  table=parse($('spreadsheet-text').value,$('spreadsheet-header').value);const mapping=defaults(table,$('spreadsheet-type').value);
  const targets=$('spreadsheet-type').value==='histogram'?[['samples','Measurements']]:[['x','X'],['y','Y'],['ex','X uncertainty'],['ey','Y uncertainty']];
  $('spreadsheet-preview').innerHTML='<p class="hint">'+table.rows.length+' measurement rows. Preview shows the first 5.</p><div class="spreadsheet-scroll"><table><thead><tr>'+table.headers.map(h=>'<th>'+escape(h)+'</th>').join('')+'</tr><tr>'+table.headers.map((h,i)=>'<th><select aria-label="Use '+escape(h)+' as" data-paste-column="'+i+'"><option value="">Ignore</option>'+targets.map(([v,n])=>'<option value="'+v+'" '+(mapping[i]===v?'selected':'')+'>'+n+'</option>').join('')+'</select></th>').join('')+'</tr></thead><tbody>'+table.rows.slice(0,5).map(r=>'<tr>'+table.headers.map((_,i)=>'<td>'+escape(r[i]??'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
 }catch(e){$('spreadsheet-preview').innerHTML='';if($('spreadsheet-text').value.trim())$('spreadsheet-error').textContent=e.message;}
}
function destination(){const disabled=!!datasets[activeIdx]?.derivedFrom||datasets[activeIdx]?.analysis_type!==$('spreadsheet-type').value;$('spreadsheet-destination').querySelector('[value=replace]').disabled=disabled;if(disabled)$('spreadsheet-destination').value='new';}
for(const b of document.querySelectorAll('[data-paste-spreadsheet]'))b.addEventListener('click',()=>{
 $('spreadsheet-name').value='Dataset '+(datasets.length+(datasets[activeIdx]?.analysis_type?1:0));$('spreadsheet-type').value=datasets[activeIdx]?.analysis_type||'xy';$('spreadsheet-destination').value='new';$('spreadsheet-text').value='';$('spreadsheet-header').value='auto';preview();destination();dialog.showModal();$('spreadsheet-text').focus();
});
$('spreadsheet-destination').addEventListener('change',()=>{$('spreadsheet-name').value=$('spreadsheet-destination').value==='replace'?datasets[activeIdx].name:'Dataset '+(datasets.length+1);});
$('spreadsheet-text').addEventListener('input',preview);$('spreadsheet-header').addEventListener('change',preview);$('spreadsheet-type').addEventListener('change',()=>{preview();destination();});$('spreadsheet-cancel').onclick=()=>dialog.close();
$('spreadsheet-form').onsubmit=async e=>{
 e.preventDefault();
 try{
  if(!table)throw Error('Paste data to preview it first.');
  if(!$('spreadsheet-name').value.trim())throw Error('Enter a dataset name.');
  const type=$('spreadsheet-type').value,mapping=[...dialog.querySelectorAll('[data-paste-column]')].map(s=>s.value),data=convert(table,mapping,type),replace=$('spreadsheet-destination').value==='replace';
  if(replace&&!await askDialog({title:'Replace dataset data',message:'Replace the measurements in “'+datasets[activeIdx].name+'”? Its previous result will be cleared; its fit settings will be kept.',accept:'Replace',cancel:'Cancel',destructive:true}))return;
  syncActiveFromColumns();
  const d=replace?datasets[activeIdx]:newDataset($('spreadsheet-name').value.trim(),type);d.name=$('spreadsheet-name').value.trim()||d.name;
  if(type==='xy')for(const c of ['x','y','ex','ey'])d[c]=data[c];else d.histogram={...d.histogram,source:'samples',samples:data.samples};
  delete d.result;
  if(!replace){if(!datasets[activeIdx].analysis_type)datasets[activeIdx]=d;else{datasets.push(d);activeIdx=datasets.length-1;}}
  resetResult();showActiveInColumns();syncAnalysisControls();
  if(table.hasHeader){for(const [target,id] of [['x','x-title'],['y','y-title'],['samples','x-title']]){const i=mapping.indexOf(target);if(i>=0)$(id).value=table.headers[i];}}
  autosave();document.dispatchEvent(new Event('input',{bubbles:true}));dialog.close();showMessage('info','Loaded '+table.rows.length+' measurement rows.');
 }catch(e){$('spreadsheet-error').textContent=e.message;}
};
})(globalThis);
