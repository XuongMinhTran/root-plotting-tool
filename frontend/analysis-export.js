/* Editable LaTeX report bundle, generated locally without uploading session data. */
(function(scope){
'use strict';
const enc=new TextEncoder(), escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const texSpecial={'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','_':'\\_','%':'\\%','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
const mathSymbols={'α':'alpha','β':'beta','γ':'gamma','δ':'delta','ε':'epsilon','ζ':'zeta','η':'eta','θ':'theta','ι':'iota','κ':'kappa','λ':'lambda','μ':'mu','ν':'nu','ξ':'xi','π':'pi','ρ':'rho','σ':'sigma','τ':'tau','υ':'upsilon','φ':'phi','χ':'chi','ψ':'psi','ω':'omega','Γ':'Gamma','Δ':'Delta','Θ':'Theta','Λ':'Lambda','Ξ':'Xi','Π':'Pi','Σ':'Sigma','Υ':'Upsilon','Φ':'Phi','Ψ':'Psi','Ω':'Omega','±':'pm','×':'times','÷':'div','≤':'leq','≥':'geq','≠':'neq','≈':'approx','∞':'infty','∂':'partial','∇':'nabla','√':'surd','·':'cdot','⋅':'cdot','→':'rightarrow','µ':'mu'};
const punctuation={'−':'-','–':'--','—':'---','’':"'",'‘':"'",'“':'``','”':"''",'…':'\\ldots{}',' ':'~','°':'\\ensuremath{^{\\circ}}'};
const superscripts='⁰¹²³⁴⁵⁶⁷⁸⁹',subscripts='₀₁₂₃₄₅₆₇₈₉';
function tex(value){return Array.from(String(value??'')).map(c=>{
 if(texSpecial[c])return texSpecial[c];if(mathSymbols[c])return '\\ensuremath{\\'+mathSymbols[c]+'}';if(punctuation[c])return punctuation[c];
 if(superscripts.includes(c))return '\\textsuperscript{'+superscripts.indexOf(c)+'}';if(subscripts.includes(c))return '\\textsubscript{'+subscripts.indexOf(c)+'}';if(c==='⁻')return '\\textsuperscript{-}';
 const n=c.codePointAt(0);if(n<128)return n<32&&!['\n','\t'].includes(c)?'':c;
 // Standard Latin text is supported by inputenc; unsupported scripts remain explicit.
 if(n>=160&&n<=255)return c;
 return '\\texttt{[U+'+n.toString(16).toUpperCase()+']}';
}).join('');}
const csv=rows=>rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function zip(files){
 const chunks=[],central=[];let offset=0;
 const header=(n)=>{const a=new Uint8Array(n);return [a,new DataView(a.buffer)];};
 for(const [path,value] of Object.entries(files)){
  const name=enc.encode(path),data=typeof value==='string'?enc.encode(value):value,checksum=crc(data);
  const [h,v]=header(30);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,checksum,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);
  chunks.push(h,name,data);const [c,d]=header(46);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint32(16,checksum,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);central.push(c,name);offset+=30+name.length+data.length;
 }
 const size=central.reduce((n,a)=>n+a.length,0),[end,v]=header(22);v.setUint32(0,0x06054b50,true);v.setUint16(8,Object.keys(files).length,true);v.setUint16(10,Object.keys(files).length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
 return new Blob([...chunks,...central,end],{type:'application/zip'});
}
function table(headers,rows){return '\\begin{longtable}{'+headers.map(()=>'>{\\raggedright\\arraybackslash}p{\\dimexpr\\linewidth/'+headers.length+'-2\\tabcolsep\\relax}').join('')+'}\n'+headers.map(tex).join(' & ')+' \\\\ \\hline\n'+rows.map(r=>r.map(tex).join(' & ')+' \\\\').join('\n')+'\n\\end{longtable}\n';}
function report(doc,ids,options={}){
 const opts={graphs:true,raw:true,fit:true,calculations:true,session:true,notes:true,...options};
 const files=opts.session?{'session.json':JSON.stringify(doc,null,2)}:{},sections=[];
 for(const [i,d] of doc.inputs.datasets.entries()){
  if(!ids.includes(d.id)||!(opts.raw||opts.fit||opts.graphs))continue;
  const stem='dataset-'+(i+1),raw=scope.WorkspaceStore.objects({...doc,inputs:{...doc.inputs,datasets:[d]}}).find(o=>o.kind==='measurements');
  let text='\\section{'+tex(d.name)+'}\n';
  if(opts.raw&&raw?.columns?.length){
   const c=raw.columns,headers=['Row',...c.flatMap(c=>[c.name+(c.unit?' ('+c.unit+')':''),'u('+c.name+')']),'Included in fit','Exclusion reason'];
   const xy=s=>String(s??'').trim().split(/[\s,;]+/).filter(Boolean).map(Number),xs=xy(d.x),ys=xy(d.y);
   const rows=Array.from({length:c[0].values.length},(_,r)=>{const p=(d.exclusions||[]).find(p=>p.index===r&&p.x===xs[r]&&p.y===ys[r]);return[r+1,...c.flatMap(c=>[c.values[r],c.errors?.[r]??'']),p?'No':'Yes',p?.reason||''];});
   files[stem+'-data.csv']=csv([headers,...rows]);text+='Measurements and standard uncertainties: '+tex(stem+'-data.csv')+'. Empty uncertainty cells are unspecified.\n';
   if(rows.length<=100&&headers.length<=8)text+=table(headers,rows);else text+='The complete table is supplied as CSV ('+rows.length+' rows).\n';
  }
  const r=d.result?.response;
  if(r){
   const stale=d.result.sourceSignature&&d.result.sourceSignature!==scope.WorkspaceStore.signature(d);
   if(opts.fit){text+='\\subsection{Saved fit result}\n'+(stale?'\\textbf{The inputs have changed since this fit. This result is a saved snapshot.}\\par\n':'');
   text+='Function: \\texttt{'+tex(r.formula)+'}.\\par\n'+tex(r.status_message)+'\\par\n';
   text+='Fit range: '+tex(JSON.stringify(r.range))+'; NDF: '+tex(r.ndf)+'; '+tex(r.statistic_name||'Chi-square')+': '+tex(r.statistic??r.chi2)+'; probability: '+tex(r.prob)+'.\\par\n';
   text+='Fit settings: \\texttt{'+tex(JSON.stringify(d.result.payload?.initial_guesses||[]))+'} (initial guesses); method: '+tex(r.method||'ROOT TGraphErrors chi-square fit')+'.\\par\n';
   const rows=(r.params||[]).map(p=>[p.name,p.value,p.error]);files[stem+'-parameters.csv']=csv([['Parameter','Value','Standard uncertainty'],...rows]);text+=table(['Parameter','Value','Standard uncertainty'],rows);
   if(r.covariance?.length){const names=(r.params||[]).map(p=>p.name),matrix=r.covariance.map((row,i)=>row.map((v,j)=>{const den=Math.sqrt(r.covariance[i][i]*r.covariance[j][j]);return den?v/den:'';}));files[stem+'-correlation.csv']=csv([['Parameter',...names],...matrix.map((row,i)=>[names[i],...row])]);text+='Correlation matrix: '+tex(stem+'-correlation.csv')+'.\\par\n';if(names.length<=6)text+=table(['Parameter',...names],matrix.map((row,i)=>[names[i],...row.map(v=>v===''?'—':Number(v).toPrecision(4))]));}
   if(r.confidence_band){const b=r.confidence_band;files[stem+'-confidence.csv']=csv([['x','fitted value','half width'],...b.x.map((x,i)=>[x,b.y[i],b.errors[i]])]);text+=Math.round(b.level*100)+'\\% pointwise confidence band. '+tex(b.method)+'\\par\n';}
   }
   if(opts.graphs&&r.canvas_json)text+='\\begin{figure}[ht]\\centering\\includegraphics[width=\\linewidth]{figures/'+stem+'.png}\\caption{'+tex(d.name)+(stale?' (saved fit; inputs subsequently changed)':'')+'}\\end{figure}\n';
  }
  sections.push(text);
 }
 // Every calculation is retained with its source identities; the complete session is included.
 for(const o of doc.objects||[])if(opts.calculations&&o.kind==='calculation'&&(!opts.calculationIds||opts.calculationIds.includes(o.id))){
  let text='\\section{Calculation: '+tex(o.name)+'}\nExpression: \\texttt{'+tex(o.expression)+'}; unit: '+tex(o.unit)+'.\\par\n';
  const objects=scope.WorkspaceStore.objects(doc),bindings=Object.entries(o.bindings||{}).map(([symbol,b])=>{const src=objects.find(x=>x.id===b.id),f=src&&scope.AnalysisCore.fields(src).find(f=>f.key===b.key);return b.literal?[symbol,'Entered value',b.value+' ± '+b.error+(b.unit?' '+b.unit:'')]:[symbol,src?.name||'Missing source',(f?.name||b.key)+(b.unit?' ['+b.unit+']':'')];});text+=table(['Symbol','Source','Quantity'],bindings);text+=tex(o.unitMode==='checked'?'Units converted and dimensions checked.':'Legacy calculation: units treated as labels without conversion.')+'\\par\n';
  try{const rows=scope.AnalysisCore.engine(objects.filter(o=>!o.incomplete)).get(o.id).map((r,i)=>[i+1,r.value,r.uncertainty??'',o.unit||'']);const path='calculation-'+(doc.objects.indexOf(o)+1)+'.csv';files[path]=csv([['Row','Value','Standard uncertainty','Unit'],...rows]);text+='First-order numerical uncertainty propagation retaining source covariance. Results: '+tex(path)+'.\n';if(rows.length<=30)text+=table(['Row','Value','Standard uncertainty','Unit'],rows);}catch(e){if(opts.strict)throw Error('Cannot export '+o.name+': '+e.message);text+='Result unavailable: '+tex(e.message);}
  sections.push(text);
 }
 files['report.tex']='\\documentclass{article}\n\\usepackage[margin=20mm]{geometry}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb,textcomp,graphicx,longtable,array}\n\\setlength{\\emergencystretch}{3em}\n\\begin{document}\n\\title{'+tex(doc.title||'Analysis report')+'}\n\\date{}\\maketitle\nGenerated by ROOT-A-TRON 3000.\\par\n'+tex(opts.notes?doc.notes||'':'')+'\n'+sections.join('\n\\clearpage\n')+'\n\\end{document}\n';
 files['README.txt']='Overleaf: New Project > Upload Project, then choose this entire ZIP. Select report.tex as the main document and use pdfLaTeX (the default). Keep the figures folder alongside report.tex. Uploading report.tex alone omits the graphs. Tables contain full numerical values. Contents follow the selections in the Export dialog. If included, session.json contains the ENTIRE session, including unselected datasets and calculations. Saved fits may predate the current inputs; these are labeled in the report.\n';return files;
}
async function images(doc,ids,files,format='both'){
 const datasets=doc.inputs.datasets.filter(d=>ids.includes(d.id)&&d.result?.response?.canvas_json);if(!datasets.length)return;
 if(!scope.JSROOT){for(const url of ['vendor/jsroot/jsroot.js','https://root.cern/js/latest/build/jsroot.min.js','https://root.cern/js/latest/build/jsroot.js']){try{await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=resolve;s.onerror=()=>{s.remove();reject(Error('Renderer unavailable'));};document.head.append(s);});if(scope.JSROOT)break;}catch{}}if(!scope.JSROOT)throw Error('The figure renderer could not load. Check the connection and retry.');}

 for(const d of datasets){const host=document.createElement('div');host.className='export-render-host';document.body.append(host);let painter;
  try{painter=await scope.JSROOT.draw(host,scope.JSROOT.parse(JSON.stringify(d.result.response.canvas_json)),'');const canvas=painter.getCanvPainter?.()||painter;const svg=await canvas.produceImage(true,'svg');if(!svg)throw Error('Could not export the plot for '+d.name);const stem='figures/dataset-'+(doc.inputs.datasets.indexOf(d)+1);if(format!=='png')files[stem+'.svg']=svg;
   if(format==='svg')continue;
   const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Could not create PNG for '+d.name));image.src=url;});const c=document.createElement('canvas');c.width=2000;c.height=Math.round(2000*(image.naturalHeight||700)/(image.naturalWidth||1000));const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(image,0,0,c.width,c.height);const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));if(!blob)throw Error('PNG export failed');files[stem+'.png']=new Uint8Array(await blob.arrayBuffer());}finally{URL.revokeObjectURL(url);}
  }finally{painter?.cleanup?.();host.remove();}
 }
}
function open(doc){
 doc=JSON.parse(JSON.stringify(doc));const dlg=document.createElement('dialog');dlg.className='tframe feature-dialog export-dialog';dlg.setAttribute('aria-labelledby','export-heading');
 const calculations=(doc.objects||[]).filter(o=>o.kind==='calculation'),hasGraphs=doc.inputs.datasets.some(d=>d.result?.response?.canvas_json);
 dlg.innerHTML='<form><h2 id="export-heading">Export</h2><label class="export-title">Title<input data-export-title value="'+escape(doc.title||'Analysis')+'" required maxlength="200"></label><fieldset><legend>Include</legend><div class="export-list export-content"><label><input type="checkbox" data-content="graphs" '+(hasGraphs?'checked':'disabled')+'>Graphs</label><label><input type="checkbox" data-content="calculations" '+(calculations.length?'checked':'disabled')+'>Calculated values and columns</label><label><input type="checkbox" data-content="fit">Fit parameters and diagnostics</label><label><input type="checkbox" data-content="raw" '+(!hasGraphs&&!calculations.length?'checked':'')+'>Raw data and exclusion reasons</label><label><input type="checkbox" data-content="notes">Document notes</label><label><input type="checkbox" data-content="session">Complete session (JSON)</label></div><p class="hint">Complete session includes all datasets and calculations, regardless of the selections below.</p></fieldset><fieldset data-datasets><legend>Datasets</legend><div class="export-list">'+doc.inputs.datasets.filter(d=>d.analysis_type).map(d=>`<label><input type="checkbox" data-dataset value="${escape(d.id)}" checked>${escape(d.name)}${d.result?.response?.canvas_json?'':' — no saved graph'}</label>`).join('')+'</div></fieldset><fieldset data-calculations><legend>Calculations</legend><div class="export-list">'+calculations.map(o=>`<label><input type="checkbox" data-calculation value="${escape(o.id)}" checked>${escape(o.name)}</label>`).join('')+'</div></fieldset><div class="export-formats"><label>Format<select data-format><option value="pdf">PDF report (.pdf)</option><option value="latex">LaTeX report (.zip)</option><option value="files">Individual files (images, CSV, JSON)</option></select></label><label data-image-label>Graph format<select data-image-format><option value="png">PNG</option><option value="svg">SVG</option><option value="both">PNG and SVG</option></select></label></div><p class="hint" data-format-help></p><p class="export-status" role="status"></p><div class="row actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Export</button></div></form>';
 const content=name=>dlg.querySelector(`[data-content="${name}"]`).checked;
 function update(){const format=dlg.querySelector('[data-format]').value,latex=format==='latex',pdf=format==='pdf';dlg.querySelector('[data-datasets]').hidden=!['graphs','fit','raw'].some(content);dlg.querySelector('[data-calculations]').hidden=!content('calculations');dlg.querySelector('[data-image-label]').hidden=!content('graphs')||latex||pdf;dlg.querySelector('[data-content="notes"]').disabled=format==='files';dlg.querySelector('[data-content="session"]').disabled=pdf;if(pdf)dlg.querySelector('[data-content="session"]').checked=false;dlg.querySelector('[data-format-help]').textContent=pdf?'Download a PDF containing the selected graphs, calculations, and tables. Save the session separately to preserve editable data.':latex?'ZIP containing editable report.tex, selected tables, and PNG/SVG graphs. Upload the entire ZIP to Overleaf as a new project; report.tex uses the default pdfLaTeX compiler. A compiled PDF is not included.':'A single file downloads directly. Multiple files are packaged in a ZIP. CSV tables include values and uncertainties.';}
 dlg.querySelectorAll('input,select').forEach(c=>c.addEventListener('change',update));update();
 dlg.querySelector('[data-cancel]').onclick=()=>dlg.close();dlg.onclose=()=>dlg.remove();
 dlg.querySelector('form').onsubmit=async e=>{
  e.preventDefault();const button=dlg.querySelector('[type=submit]'),status=dlg.querySelector('.export-status');button.disabled=true;status.textContent='Preparing export…';
  try{
   const ids=[...dlg.querySelectorAll('[data-dataset]:checked')].map(c=>c.value),calculationIds=[...dlg.querySelectorAll('[data-calculation]:checked')].map(c=>c.value),format=dlg.querySelector('[data-format]').value,latex=format==='latex',pdf=format==='pdf';
   const options=Object.fromEntries(['graphs','calculations','fit','raw','session','notes'].map(k=>[k,content(k)]));options.notes=(latex||pdf)&&options.notes;if(pdf)options.session=false;options.calculationIds=calculationIds;options.strict=true;
   if(!['graphs','calculations','fit','raw','session','notes'].some(k=>options[k]))throw Error('Select at least one item to export.');
   if(['graphs','fit','raw'].some(k=>options[k])&&!ids.length)throw Error('Select at least one dataset.');
   if(options.calculations&&!calculationIds.length)throw Error('Select at least one calculation.');
   if(options.graphs&&!doc.inputs.datasets.some(d=>ids.includes(d.id)&&d.result?.response?.canvas_json))throw Error('The selected datasets have no saved graphs. Run a fit or turn off Graphs.');
   const title=dlg.querySelector('[data-export-title]').value.trim();if(!title)throw Error('Enter a title for the export.');
   const exportDoc={...doc,title};
   const files=report(exportDoc,ids,options);if(options.session)files['session.json']=JSON.stringify(doc,null,2);if(!latex){delete files['report.tex'];delete files['README.txt'];}
   if(options.graphs)await images(doc,ids,files,latex?'both':pdf?'png':dlg.querySelector('[data-image-format]').value);
   if(pdf){const {createPDF}=await import('./analysis-pdf.mjs');const bytes=await createPDF(exportDoc,ids,options,files);for(const key of Object.keys(files))delete files[key];files['report.pdf']=bytes;}
   const entries=Object.entries(files);if(!entries.length)throw Error('No matching results are available for this selection.');
   const stem=title.replace(/[^\w -]/g,'_')||'analysis';let blob,name;
   if(!latex&&entries.length===1){const [path,data]=entries[0],ext=path.split('.').pop(),mime={pdf:'application/pdf',png:'image/png',svg:'image/svg+xml',csv:'text/csv',json:'application/json'}[ext]||'text/plain';blob=new Blob([data],{type:mime});name=stem+'-'+path.split('/').pop();}else{blob=zip(files);name=stem+'-export.zip';}
   const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='Export download requested.';
  }catch(e){status.textContent=e.message;}finally{button.disabled=false;}
 };document.body.append(dlg);dlg.showModal();
}
const api={open,report,zip,tex,csv};if(typeof module==='object')module.exports=api;else scope.AnalysisExport=api;
})(globalThis);
