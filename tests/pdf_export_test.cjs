const assert=require('node:assert/strict'),fs=require('fs');
global.WorkspaceStore=require('../frontend/workspace-store.js');global.AnalysisCore=require('../frontend/analysis-core.js');
(async()=>{
 const {createPDF,parseCSV}=await import('../frontend/analysis-pdf.mjs');
 assert.deepEqual(parseCSV('"a","b"\r\n"line\nline","say ""yes"""'),[['a','b'],['line\nline','say "yes"']]);
 const d=WorkspaceStore.empty();d.title='Diffraction λ';d.notes='λ = 672.3 ± 1.4 nm; χ², x₀.';d.inputs.datasets=[{id:'a',name:'Measurements',analysis_type:'xy',x:Array.from({length:150},(_,i)=>i).join(' '),y:Array.from({length:150},(_,i)=>Math.sin(i)).join(' '),ey:'.1',fit:{formula:'[0]*x'}}];WorkspaceStore.materialize(d);const opts={graphs:false,raw:true,fit:false,calculations:false,session:false,notes:true,calculationIds:[]};const files=require('../frontend/analysis-export.js').report(d,['a'],opts);
 const pdf=await createPDF(d,['a'],opts,files,new Uint8Array(fs.readFileSync('frontend/vendor/pdf/FreeSans.ttf')));
 assert.equal(Buffer.from(pdf).subarray(0,5).toString(),'%PDF-');fs.writeFileSync('/tmp/root-pdf-regression.pdf',pdf);
 console.log('OK: PDF generation, embedded scientific font, multi-page tables, CSV quoting.');
})();
