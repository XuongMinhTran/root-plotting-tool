/* Scientific worksheet model. Expressions use the existing bounded parser. */
(function(scope){
'use strict';
const E=typeof module==='object'?require('./equation-parser.js'):scope.RootEquation;
const U=typeof module==='object'?require('./units.js'):scope.AnalysisUnits;
const fail=m=>{throw Error(m);};
const finite=v=>typeof v==='number' && Number.isFinite(v);
function covariance(parameters, matrix) {
 const n=parameters.length;
 if(!n || n>100) fail('Provide between 1 and 100 quantities.');
 parameters.forEach(p=>{if(!finite(p.value)||!finite(p.error)||p.error<0) fail('Values must be finite; standard uncertainties must be nonnegative.');});
 const c=matrix || parameters.map((p,i)=>parameters.map((_,j)=>i===j?p.error*p.error:0));
 if(c.length!==n || c.some(r=>!Array.isArray(r)||r.length!==n||r.some(v=>!finite(v)))) fail('The covariance matrix must match the parameter table.');
 for(let i=0;i<n;i++) for(let j=0;j<n;j++) {
  if(c[i][i]<0 || Math.abs(c[i][j]-c[j][i])>1e-8*Math.max(1e-30,Math.abs(c[i][j]),Math.abs(c[j][i]))) fail('The covariance matrix must be symmetric with nonnegative variances.');
 }
 // Test positive semidefiniteness on the correlation scale.
 const l=Array.from({length:n},()=>Array(n).fill(0));
 for(let i=0;i<n;i++) for(let j=0;j<=i;j++) {
  const den=Math.sqrt(c[i][i]*c[j][j]);
  if(!den && c[i][j]!==0) fail('Zero-variance quantities cannot have nonzero covariance.');
  let v=den?c[i][j]/den:0;
  for(let k=0;k<j;k++) v-=l[i][k]*l[j][k];
  if(i===j) {if(v< -1e-7) fail('The covariance matrix is not positive semidefinite.');l[i][j]=Math.sqrt(Math.max(0,v));}
  else if(l[j][j]>1e-12) l[i][j]=v/l[j][j];
  else if(Math.abs(v)>1e-7) fail('The covariance matrix is not positive semidefinite.');
 }
 return c;
}
function engine(objects) {
 const map=new Map(objects.map(o=>[o.id,o])), blocks=[], cache=new Map(), visiting=new Set();
 if(map.size!==objects.length) fail('Object identifiers must be unique.');
 for(const o of objects) {
  if(o.kind==='calculation')for(const [symbol,b] of Object.entries(o.bindings||{}))if(b.literal){
   if(!finite(b.value)||!finite(b.error)||b.error<0)fail('Enter a finite value and a nonnegative standard uncertainty for '+symbol+'.');
   blocks.push({keys:[o.id+':literal:'+symbol],matrix:[[b.error*b.error]]});
  }
  if(o.kind==='fit'||o.kind==='values') blocks.push({keys:o.parameters.map((_,i)=>o.id+':'+i),matrix:covariance(o.parameters,o.covariance)});
  if(o.kind==='measurements') {
   if(!o.columns?.length || o.columns.length>20) fail('Provide between 1 and 20 columns.');
   const n=o.columns[0].values.length;
   if(!n || n>10000) fail('Provide between 1 and 10,000 rows.');
   for(let c=0;c<o.columns.length;c++) {
    const col=o.columns[c];
    if(col.values.length!==n || col.values.some(v=>!finite(v))) fail('Measurement columns need equal lengths and finite values.');
    if(col.errors && (col.errors.length!==n || col.errors.some(v=>!finite(v)||v<0))) fail('Uncertainties need one nonnegative value per row.');
    for(let r=0;r<n;r++) blocks.push({keys:[o.id+':'+c+':'+r],matrix:[[(col.errors?.[r]||0)**2]]});
   }
  }
 }
 const byKey=new Map();for(const b of blocks)for(const key of b.keys)byKey.set(key,b);
 const variance=g=>{
  let v=0,scale=0;
  const relevant=new Set(Object.keys(g).map(k=>byKey.get(k)).filter(Boolean));
  for(const b of relevant) for(let i=0;i<b.keys.length;i++) for(let j=0;j<b.keys.length;j++) {
   const term=(g[b.keys[i]]||0)*b.matrix[i][j]*(g[b.keys[j]]||0);v+=term;scale+=Math.abs(term);
  }
  if(!finite(v)||v< -1e-8*Math.max(scale,1e-30)) fail('The propagated variance is invalid.');
  return Math.max(0,v);
 };
 const item=(value,g,known=true)=>({value,g,uncertainty:known?Math.sqrt(variance(g)):null});
 function get(id,key='value') {
  const token=JSON.stringify([id,String(key)]);
  if(cache.has(token)) return cache.get(token);
  if(visiting.has(token)) fail('This calculation would depend on itself.');
  visiting.add(token);
  try {
   const o=map.get(id);if(!o) fail('A source is missing or incomplete. Restore it or update the calculation.');
   if(o.stale) fail('The source data or model has changed since this fit. Refit it before using its parameters in a calculation.');
   let out;
   if(o.kind==='fit'||o.kind==='values') {
    const p=o.parameters[Number(key)];if(!p) fail('Select a source parameter.');
    out=[item(p.value,{[o.id+':'+key]:1})];
   } else if(o.kind==='measurements') {
    const col=o.columns[Number(key)];if(!col) fail('Select a measurement column.');
    out=col.values.map((v,r)=>item(v,{[o.id+':'+key+':'+r]:1},!!col.errors));
   } else if(o.kind==='calculation') {
    const expr=E.expression(o.expression), inputs={}, units={};
    const checked=o.unitMode==='checked';
    for(const symbol of expr.variables) {
     const b=o.bindings?.[symbol];if(!b) fail('Assign a source to '+E.symbolLabel(symbol)+'.');
     inputs[symbol]=b.literal?[item(b.value,{[o.id+':literal:'+symbol]:1})]:get(b.id,b.key);
     if(checked){
      const source=map.get(b.id),field=source?fields(source).find(f=>f.key===String(b.key)):null;
      const unit=b.literal?b.unit:(b.unit||field?.unit);
      try{units[symbol]=U.parse(unit);}catch(e){fail(E.symbolLabel(symbol)+': '+e.message);}
      if(!b.literal&&field?.unit&&b.unit&&b.unit!==field.unit)fail('The source already has unit '+field.unit+'. Use that unit for '+E.symbolLabel(symbol)+'.');
      const scale=units[symbol].scale;
      inputs[symbol]=inputs[symbol].map(row=>item(row.value*scale,Object.fromEntries(Object.entries(row.g).map(([k,v])=>[k,v*scale])),row.uncertainty!==null));
     }
    }
    let outputScale=1;
    if(checked){const target=U.parse(o.unit);if(!U.same(U.dimension(expr.ast,units),target))fail('The result unit is incompatible with the expression. Check source and result units.');outputScale=target.scale;}
    const n=Math.max(1,...Object.values(inputs).map(a=>a.length));
    if(Object.values(inputs).some(a=>a.length!==1 && a.length!==n)) fail('Columns must have equal row counts. Scalar quantities apply to every row.');
    out=Array.from({length:n},(_,r)=>{
     const values={}, selected={};
     for(const [k,a] of Object.entries(inputs)) {selected[k]=a[a.length===1?0:r]; values[k]=selected[k].value;}
     const value=expr.evaluate(values), g={};let known=true;
     for(const k of expr.variables) {
      const v=values[k],h=Math.cbrt(Number.EPSILON)*Math.max(Math.abs(v),selected[k].uncertainty||0,1e-8);
      const diff=step=>(expr.evaluate({...values,[k]:v+step})-expr.evaluate({...values,[k]:v-step}))/(2*step);
      const d=diff(h),d2=diff(h/2);
      if(!finite(d2)||Math.abs(d-d2)>1e-4*Math.max(1,Math.abs(d2))) fail('The numerical derivative is unstable near these inputs. Check the expression and its domain.');
      // abs/min/max at a corner do not have a unique derivative.
      const left=(value-expr.evaluate({...values,[k]:v-h}))/h, right=(expr.evaluate({...values,[k]:v+h})-value)/h;
      if(Math.abs(left-right)>1e-3*Math.max(1,Math.abs(left),Math.abs(right))) fail('The expression is not differentiable at these inputs.');
      if(selected[k].uncertainty===null) known=false;
      for(const [base,weight] of Object.entries(selected[k].g)) g[base]=(g[base]||0)+d2*weight;
     }
     return item(value/outputScale,Object.fromEntries(Object.entries(g).map(([k,v])=>[k,v/outputScale])),known);
    });
   } else fail('Unsupported object type.');
   cache.set(token,out);return out;
  } finally {visiting.delete(token);}
 }
 return {get};
}
function stats(values) {
 const n=values.length,mean=values.reduce((s,x)=>s+x,0)/n;
 const sd=n>1?Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/(n-1)):null;
 return {n,mean,sd,sem:sd===null?null:sd/Math.sqrt(n)};
}
function fields(o) {
 return o.kind==='measurements'?o.columns.map((c,i)=>({key:String(i),name:c.name,unit:c.unit||''})):
 o.kind==='calculation'?[{key:'value',name:o.name,unit:o.unit||''}]:o.parameters.map((p,i)=>({key:String(i),name:p.name||'p'+i,unit:p.unit||''}));
}
const api={engine,stats,fields,covariance};if(typeof module==='object')module.exports=api;else scope.AnalysisCore=api;
})(globalThis);
