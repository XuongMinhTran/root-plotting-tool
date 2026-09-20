/* Shared plotting analysis controls. All values live on the selected dataset. */
(() => {
'use strict';
const el=id=>document.getElementById(id), escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function refresh(){
 const d=datasets[activeIdx];if(!d)return;
 el('confidence-level').value=String(d.confidenceLevel||'');
 el('point-exclusions').disabled=d.analysis_type!=='xy';
 el('point-exclusions').textContent='Point exclusions'+(d.exclusions?.length?' ('+d.exclusions.length+')':'')+'…';
}
function exclusions(){
 syncActiveFromColumns();const d=datasets[activeIdx],x=parseColumn(d.x),y=parseColumn(d.y);
 if(x.bad.length||y.bad.length||!x.values.length||x.values.length!==y.values.length){askDialog({title:'Enter XY data first',message:'Enter matching numeric X and Y columns before excluding measurements.',cancel:null});return;}
 openExclusions(d,x,y,next=>{d.exclusions=next;autosave();refresh();showMessage('info','Exclusions saved. Run Fit to update the result.');});
}
function openExclusions(d,x,y,onApply){
 const dlg=document.createElement('dialog');dlg.className='tframe feature-dialog exclusion-dialog';
 const omitted=x.values.map((v,i)=>d.exclusions?.find(p=>p.index===i&&p.x===v&&p.y===y.values[i])||null);
 dlg.innerHTML='<form><h2 id="exclusion-title">Point exclusions - '+escape(d.name)+'</h2><p>Select points, then choose Exclude selected or Include selected. Shift-click selects a continuous range. Exclusions affect the fit and residuals; the original values remain saved.</p><div class="exclusion-selection"><label>Rows<input data-range placeholder="e.g. 1-5, 8, 12-16" aria-describedby="exclusion-range-help"></label><button type="button" data-select-range>Select rows</button><button type="button" data-select-all>Select all</button><button type="button" data-clear-selection>Clear selection</button></div><p id="exclusion-range-help" class="hint">Row numbers start at 1. Selecting rows does not change their inclusion in the fit.</p><p data-selection-error role="alert"></p><div class="exclusion-bulk"><label>Reason for selected points (optional)<input data-bulk-reason placeholder="e.g. Detector saturation"></label><button type="button" data-exclude>Exclude selected</button><button type="button" data-include>Include selected</button></div><p data-count aria-live="polite"></p><div class="feature-table"><table><thead><tr><th><input type="checkbox" data-select-visible aria-label="Select all rows"></th><th>Row</th><th>X</th><th>Y</th><th>Fit inclusion</th><th>Reason (optional)</th></tr></thead><tbody>'+x.values.map((v,i)=>`<tr><td><input type="checkbox" data-select="${i}" aria-label="Select row ${i+1}"></td><td>${i+1}</td><td>${v}</td><td>${y.values[i]}</td><td><button type="button" data-row="${i}" aria-label="Exclude row ${i+1}"></button></td><td><input data-reason="${i}" value="${escape(omitted[i]?.reason||'')}" aria-label="Reason for excluding row ${i+1}"></td></tr>`).join('')+'</tbody></table></div><div class="row actions"><button type="button" data-all>Include all points</button><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Apply exclusions</button></div><p class="hint">Run Fit after applying changes. Excluded points appear as open gray markers.</p></form>';
 dlg.setAttribute('aria-labelledby','exclusion-title');
 const selected=new Set(),excluded=new Set(omitted.flatMap((p,i)=>p?[i]:[]));let anchor=null;
 const checks=[...dlg.querySelectorAll('[data-select]')],toggles=[...dlg.querySelectorAll('[data-row]')];
 function render(){
  checks.forEach((c,i)=>{c.checked=selected.has(i);c.closest('tr').classList.toggle('point-selected',selected.has(i));});
  toggles.forEach((c,i)=>{const off=excluded.has(i);c.textContent=off?'Excluded':'Included';c.setAttribute('aria-label',(off?'Include':'Exclude')+' row '+(i+1));c.classList.toggle('point-excluded',off);});
  const all=dlg.querySelector('[data-select-visible]');all.checked=selected.size===checks.length;all.indeterminate=selected.size>0&&selected.size<checks.length;
  dlg.querySelector('[data-count]').textContent=selected.size+' selected · '+excluded.size+' excluded · '+(checks.length-excluded.size)+' included';
  dlg.querySelector('[data-exclude]').disabled=dlg.querySelector('[data-include]').disabled=!selected.size;
 }
 checks.forEach((c,i)=>c.addEventListener('click',e=>{const on=c.checked;if(e.shiftKey&&anchor!==null){for(let n=Math.min(anchor,i);n<=Math.max(anchor,i);n++)on?selected.add(n):selected.delete(n);}else on?selected.add(i):selected.delete(i);anchor=i;render();}));
 toggles.forEach((c,i)=>c.onclick=()=>{excluded.has(i)?excluded.delete(i):excluded.add(i);render();});
 function selectAll(on){selected.clear();if(on)checks.forEach((_,i)=>selected.add(i));anchor=null;render();}
 dlg.querySelector('[data-select-all]').onclick=()=>selectAll(true);
 dlg.querySelector('[data-clear-selection]').onclick=()=>selectAll(false);
 dlg.querySelector('[data-select-visible]').onchange=e=>selectAll(e.target.checked);
 dlg.querySelector('[data-select-range]').onclick=()=>{
  const text=dlg.querySelector('[data-range]').value.trim(),next=new Set(),error=dlg.querySelector('[data-selection-error]');error.textContent='';
  if(!text){error.textContent='Enter row numbers or a range, such as 1-5, 8.';return;}
  for(const part of text.split(',')){const m=part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);const lo=Number(m?.[1]),hi=Number(m?.[2]||m?.[1]);if(!m||lo<1||hi<lo||hi>checks.length){error.textContent='Use rows from 1 to '+checks.length+' with increasing ranges, such as 1-5, 8.';return;}for(let n=lo;n<=hi;n++)next.add(n-1);}
  selected.clear();next.forEach(i=>selected.add(i));anchor=null;render();
 };
 dlg.querySelector('[data-range]').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();dlg.querySelector('[data-select-range]').click();}};
 dlg.querySelector('[data-exclude]').onclick=()=>{const reason=dlg.querySelector('[data-bulk-reason]').value.trim();selected.forEach(i=>{excluded.add(i);if(reason)dlg.querySelector(`[data-reason="${i}"]`).value=reason;});render();};
 dlg.querySelector('[data-include]').onclick=()=>{selected.forEach(i=>excluded.delete(i));render();};
 dlg.querySelector('[data-all]').onclick=()=>{excluded.clear();render();};
 dlg.querySelector('[data-cancel]').onclick=()=>dlg.close();dlg.onclose=()=>dlg.remove();
 dlg.querySelector('form').onsubmit=e=>{e.preventDefault();const next=[...excluded].sort((a,b)=>a-b).map(i=>({index:i,x:x.values[i],y:y.values[i],reason:dlg.querySelector(`[data-reason="${i}"]`).value.trim()}));onApply(next);dlg.close();};
 document.body.append(dlg);render();dlg.showModal();

}
function renderResult(r){
 const host=el('parameter-correlations');if(!host)return;
 host.hidden=!r?.params?.length;
 if(host.hidden){host.innerHTML='';return;}
 const p=r.params,c=r.covariance;
 host.innerHTML=(lastPayload?.plot?.excluded_points?.length?'<p>'+lastPayload.plot.excluded_points.length+' excluded measurement(s), shown as open gray markers. Excluded from fitting and diagnostics.</p>':'')+'<details><summary>Parameter correlation matrix</summary><p>Dimensionless coefficients from fit covariance. A dash indicates zero variance or unavailable covariance.</p><div class="feature-table"><table><thead><tr><th>Parameter</th>'+p.map(a=>'<th>'+escape(a.name)+'</th>').join('')+'</tr></thead><tbody>'+p.map((a,i)=>'<tr><th>'+escape(a.name)+'</th>'+p.map((_,j)=>{const den=Math.sqrt((c?.[i]?.[i]||0)*(c?.[j]?.[j]||0));return '<td>'+(den?Number(c[i][j]/den).toFixed(3):' - ')+'</td>';}).join('')+'</tr>').join('')+'</tbody></table></div></details>'+(r.confidence_band?'<p>'+Math.round(r.confidence_band.level*100)+'% pointwise confidence band for the fitted curve. Covariance approximation; not a prediction interval.</p>':'');
}
function init(){
 const fit=el('formula');if(!fit)return;
 const settings=document.createElement('div');settings.className='feature-settings';settings.innerHTML='<label for="confidence-level">Confidence band</label><select id="confidence-level"><option value="">None</option><option value="0.68">68%</option><option value="0.95">95%</option><option value="0.99">99%</option></select><p class="hint">Pointwise uncertainty in the fitted curve from parameter covariance. Run Fit to update.</p>';
 (el('step-options') || el('opt-grid').closest('fieldset') || fit.parentElement).append(settings);
 const btn=document.createElement('button');btn.type='button';btn.id='point-exclusions';btn.className='small';btn.textContent='Point exclusions…';btn.onclick=exclusions;
 const row=document.querySelector('.dataset-row'),del=row&&row.querySelector('[data-action="dataset-remove"]');
 if(row){if(del)row.insertBefore(btn,del);else row.append(btn);}
 const host=document.createElement('div');host.id='parameter-correlations';el('report').after(host);
 const exportButton=document.createElement('button');exportButton.type='button';exportButton.textContent='Export';exportButton.onclick=()=>window.AnalysisExport.open(buildDocument());el('report-tools').after(exportButton);
 el('confidence-level').onchange=()=>{datasets[activeIdx].confidenceLevel=Number(el('confidence-level').value)||null;autosave();};refresh();renderResult(lastResult);
}
window.AnalysisFeatures={refresh,renderResult,openExclusions};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
