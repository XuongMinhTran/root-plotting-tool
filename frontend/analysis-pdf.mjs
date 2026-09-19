/* Browser-local PDF reports. jsPDF and FreeSans licenses are in vendor/pdf. */
import {jsPDF} from './vendor/pdf/jspdf.mjs';
export function parseCSV(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n')){row.push(cell);cell='';if(c==='\n'){rows.push(row);row=[];}}else if(c!=='\r'||quoted)cell+=c;}
 row.push(cell);rows.push(row);return rows;
}
export async function createPDF(doc,ids,options,files,fontBytes){
 const pdf=new jsPDF({unit:'mm',format:'a4',compress:true});
 const bytes=fontBytes||new Uint8Array(await (await fetch(new URL('./vendor/pdf/FreeSans.ttf',import.meta.url))).arrayBuffer());
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 pdf.addFileToVFS('FreeSans.ttf',btoa(binary));pdf.addFont('FreeSans.ttf','Report','normal');pdf.setFont('Report');pdf.setProperties({title:doc.title,creator:'ROOT-A-TRON 3000'});
 const left=18,width=174,bottom=276;let y=22;
 function page(){pdf.addPage();y=22;}
 function text(value,size=10){pdf.setFont(/[^\x00-\x7F]/.test(String(value))?'Report':'helvetica');pdf.setFontSize(size);const lines=pdf.splitTextToSize(String(value??''),width);for(const line of lines){if(y+size*.45>bottom)page();pdf.text(line,left,y);y+=size*.45;}y+=3;}
 function heading(value){if(y>245)page();y+=3;text(value,14);}
 function table(csvText){
  const [headers,...rows]=parseCSV(csvText);if(headers.length>8){for(let start=1;start<headers.length;start+=5){const indices=[0,...Array.from({length:Math.min(5,headers.length-start)},(_,i)=>start+i)];const part=[headers,...rows].map(row=>indices.map(i=>'\"'+String(row[i]??'').replace(/\"/g,'\"\"')+'\"').join(',')).join('\n');table(part);}return;}const col=width/headers.length,font=headers.length>6?7:9,line=font*.45,pad=2;
  const draw=(cells,header=false)=>{pdf.setFont('Report');pdf.setFontSize(font);const wrapped=cells.map(c=>{const value=String(c);const display=!header&&/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)?String(Number(Number(value).toPrecision(8))):value;return pdf.splitTextToSize(display,col-2*pad);});let offset=0;const count=Math.max(...wrapped.map(c=>c.length));
   while(offset<count){if(y+line+4>bottom){page();if(!header)draw(headers,true);}const n=Math.min(count-offset,Math.max(1,Math.floor((bottom-y-4)/line))),height=n*line+4;
    if(header){pdf.setFillColor(232,239,247);pdf.rect(left,y,width,height,'F');}pdf.setDrawColor(210,218,228);pdf.line(left,y+height,left+width,y+height);
    wrapped.forEach((lines,i)=>{const part=lines.slice(offset,offset+n);if(part.length)pdf.text(part,left+i*col+pad,y+pad+line*.8);});y+=height;offset+=n;
   }
  };draw(headers,true);for(const row of rows)draw(row);y+=6;
 }
 text(doc.title||'Analysis report',20);text('ROOT-A-TRON 3000',9);if(options.notes&&doc.notes)text(doc.notes);
 for(const [i,d] of doc.inputs.datasets.entries()){
  if(!ids.includes(d.id)||!(options.raw||options.fit||options.graphs))continue;
  heading(d.name);const stem='dataset-'+(i+1),r=d.result?.response;
  if(d.result?.sourceSignature&&d.result.sourceSignature!==globalThis.WorkspaceStore.signature(d))text('Saved fit: inputs have changed since this result was calculated.');
  const png=files['figures/'+stem+'.png'];if(options.graphs&&png){const info=pdf.getImageProperties(png),h=Math.min(120,width*info.height/info.width),w=h*info.width/info.height;if(y+h>bottom)page();pdf.addImage(png,'PNG',left+(width-w)/2,y,w,h);y+=h+8;}
  if(options.fit&&r){heading('Fit results');text('Function: '+r.formula);text(r.status_message||'');text((r.statistic_name||'χ²')+': '+(r.statistic??r.chi2??'—')+'   NDF: '+(r.ndf??'—')+'   Probability: '+(r.prob??'—'));if(r.range)text('Fit range: '+r.range.join(' to '));if(r.confidence_band)text(Math.round(r.confidence_band.level*100)+'% pointwise confidence band. '+(r.confidence_band.method||''));
   for(const [suffix,label] of [['parameters','Parameters'],['correlation','Parameter correlations']])if(files[stem+'-'+suffix+'.csv']){heading(label);table(files[stem+'-'+suffix+'.csv']);}
  }
  if(options.raw&&files[stem+'-data.csv']){heading('Measurements and standard uncertainties');text('Blank uncertainty cells are unspecified.',9);table(files[stem+'-data.csv']);}
 }
 for(const [k,g] of (doc.inputs.simultaneous_fits||[]).entries()){
  const r=g.result?.response;if(!r?.params?.length||!(options.fit||options.graphs)||!g.members.some(m=>ids.includes(m.datasetId)))continue;
  const stem='simultaneous-'+(k+1);heading('Simultaneous fit: '+g.name);
  if(g.result.sourceSignature&&g.result.sourceSignature!==globalThis.WorkspaceStore.groupSignature(g,doc.inputs.datasets))text('Saved fit: inputs have changed since this result was calculated.');
  const png=files['figures/'+stem+'.png'];if(options.graphs&&png){const info=pdf.getImageProperties(png),h=Math.min(120,width*info.height/info.width),w=h*info.width/info.height;if(y+h>bottom)page();pdf.addImage(png,'PNG',left+(width-w)/2,y,w,h);y+=h+8;}
  if(options.fit){text(r.status_message||'');text('Total χ²: '+r.chi2+'   NDF: '+r.ndf+'   Probability: '+(r.prob??'—')+'   Free parameters: '+r.n_free);if(r.x_error_note)text(r.x_error_note,9);
   for(const [suffix,label] of [['datasets','Datasets and their χ² contributions'],['parameters','Parameters'],['correlation','Parameter correlations']])if(files[stem+'-'+suffix+'.csv']){heading(label);table(files[stem+'-'+suffix+'.csv']);}
  }
 }
 for(const [i,o] of (doc.objects||[]).entries())if(options.calculations&&o.kind==='calculation'&&options.calculationIds.includes(o.id)){
  heading(o.name);text('Expression: '+o.expression);const result=files['calculation-'+(i+1)+'.csv'];if(result)table(result);
  text('First-order numerical uncertainty propagation, retaining source covariance.',9);text(o.unitMode==='checked'?'Units converted and dimensions checked.':'Legacy calculation: units treated as labels without conversion.',9);
  const objects=globalThis.WorkspaceStore.objects(doc);for(const [symbol,b] of Object.entries(o.bindings||{})){const source=objects.find(s=>s.id===b.id),field=source&&globalThis.AnalysisCore.fields(source).find(f=>f.key===b.key);text(symbol+' = '+(b.literal?b.value+' ± '+(b.error??'unspecified')+' '+(b.unit||''):(source?.name||'Missing source')+' / '+(field?.name||b.key)+(b.unit?' ['+b.unit+']':'')),9);}
 }
 const total=pdf.getNumberOfPages();for(let i=1;i<=total;i++){pdf.setPage(i);pdf.setFont('helvetica');pdf.setFontSize(9);pdf.text(i+' / '+total,192,287,{align:'right'});}
 return new Uint8Array(pdf.output('arraybuffer'));
}
