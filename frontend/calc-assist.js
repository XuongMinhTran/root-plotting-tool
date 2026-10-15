/* Pure helpers behind the calculation formula bar: readable symbols for
 * sources and a suggested result unit. No DOM; exported for node tests. */
(function(scope){
'use strict';
const U=typeof module==='object'?require('./units.js'):scope.AnalysisUnits;
const GREEK=new Set('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Sigma Upsilon Phi Psi Omega'.split(' '));
const RESERVED=new Set(['e']);           // Euler's number in the expression grammar

// A short symbol a physicist would write for a source: the fit's own symbol
// when there is one, otherwise one built from the name (Lifetime -> L,
// count_scale -> c_s, N0 -> N_0, sigma -> sigma). Unique within `taken`.
function symbolFor(name,preferred,taken=new Set()){
 const valid=s=>typeof s==='string'&&/^[A-Za-z]+(?:_[A-Za-z0-9]+)?$/.test(s)&&(s.length===1||GREEK.has(s.split('_')[0])||/^[A-Za-z]_/.test(s))&&!RESERVED.has(s.split('_')[0]);
 let base=valid(preferred)?preferred:fromName(String(name||'').replace(/\s*[([][^)\]]*[)\]]/g,'').trim());
 if(!valid(base))base='q';
 if(!taken.has(base))return base;
 const [stem,sub]=base.split('_');
 for(let n=2;;n++){const s=stem+'_'+(sub?sub:'')+n;if(!taken.has(s))return s;}
}
function fromName(name){
 if(/^[A-Za-z]$/.test(name))return name==='e'?'E':name;
 if(GREEK.has(name))return name;
 let m=name.match(/^([A-Za-z]+)_?\{?([A-Za-z0-9]{1,3})\}?$/);
 // N0, x_0, k_a, E_k, tau1: a letter (or Greek name) with a short subscript.
 if(m&&(m[1].length===1||GREEK.has(m[1]))&&(/\d/.test(m[2])||name.includes('_')||m[2].length===1&&/[A-Z]/.test(m[1][0])))return clean(m[1])+'_'+m[2];
 if(/^p_?\d+$/i.test(name))return 'p_'+name.replace(/\D/g,'');
 const words=name.replace(/[^A-Za-z0-9\s_]/g,'').split(/[\s_]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
 if(!words.length)return 'q';
 const first=words[0][0];
 if(!/[A-Za-z]/.test(first))return 'q';
 return clean(first)+(words.length>1&&/[A-Za-z0-9]/.test(words[1][0])?'_'+words[1][0].toLowerCase():'');
}
const clean=s=>RESERVED.has(s)?'E':s;

// ---- units as named atoms, so s*ln(2) stays "s" and V/A stays "V/A" ----
function unitAtoms(text){
 text=String(text??'').trim().replace(/[·⋅]/g,'*').replace(/−/g,'-');
 if(!text||text==='1')return {};
 const t=text.match(/[A-Za-zµμΩ]+|(?:\d+(?:\.\d*)?|\.\d+)|[*/^()+-]|\S/g)||[];let i=0;
 const bad=()=>{throw Error('unit');};
 function primary(){
  let u;
  if(t[i]==='('){i++;u=product();if(t[i++]!==')')bad();}
  else {const x=t[i++];if(x==='1')u={};else if(x&&/^[A-Za-zµμΩ]+$/.test(x))u={[x]:1};else bad();}
  if(t[i]==='^'){i++;const br=t[i]==='(';if(br)i++;let sign=1;if(t[i]==='-'){sign=-1;i++;}else if(t[i]==='+')i++;let n=Number(t[i++])*sign;if(br&&t[i]==='/'){i++;n/=Number(t[i++]);}if(br&&t[i++]!==')')bad();if(!Number.isFinite(n))bad();u=scale(u,n);}
  return u;
 }
 function product(){let u=primary();while(i<t.length&&t[i]!==')'){let sign=1;if(t[i]==='/'||t[i]==='*')sign=t[i++]==='/'?-1:1;u=combine(u,primary(),sign);}return u;}
 try{const u=product();return i===t.length?u:null;}catch{return null;}
}
const tidy=m=>Object.fromEntries(Object.entries(m).filter(([,v])=>Math.abs(v)>1e-12));
const combine=(a,b,sign=1)=>{const out={...a};for(const [k,v] of Object.entries(b))out[k]=(out[k]||0)+sign*v;return tidy(out);};
const scale=(a,n)=>tidy(Object.fromEntries(Object.entries(a).map(([k,v])=>[k,v*n])));
const equal=(a,b)=>{const ka=Object.keys(a),kb=Object.keys(b);return ka.length===kb.length&&ka.every(k=>Math.abs(a[k]-(b[k]||0))<1e-12);};
function constant(a){
 if(a.k==='number')return Number(a.v);
 if(a.k==='unary'&&a.a.k==='number')return (a.op==='-'?-1:1)*Number(a.a.v);
 if(a.k==='binary'&&a.op==='/'){const l=constant(a.a),r=constant(a.b);return l===null||r===null?null:l/r;}
 return null;
}
// Combine the named units of each symbol through the expression. Returns
// null when the names do not combine cleanly (mm + cm, x^y), in which case
// the caller falls back to dimensions.
function symbolicUnit(ast,atoms){
 function walk(a){
  if(a.k==='number'||a.k==='constant')return {};
  if(a.k==='symbol')return atoms[a.v]?{...atoms[a.v]}:null;
  if(a.k==='unary')return walk(a.a);
  if(a.k==='binary'){
   const l=walk(a.a);if(l===null)return null;
   if(a.op==='^'){if(!Object.keys(l).length)return {};const n=constant(a.b);return n===null?null:scale(l,n);}
   const r=walk(a.b);if(r===null)return null;
   if(a.op==='*')return combine(l,r);if(a.op==='/')return combine(l,r,-1);
   return equal(l,r)?l:null;
  }
  const args=a.args||[];
  if(a.v==='sqrt'){const x=walk(args[0]);return x&&scale(x,.5);}
  if(a.v==='abs')return walk(args[0]);
  if(a.v==='pow'){const x=walk(args[0]);if(!x)return null;if(!Object.keys(x).length)return {};const n=constant(args[1]);return n===null?null:scale(x,n);}
  if(a.v==='min'||a.v==='max'){const x=walk(args[0]),y=walk(args[1]);return x&&y&&equal(x,y)?x:null;}
  return {};
 }
 try{return walk(ast);}catch{return null;}
}
function formatAtoms(m){
 const num=Object.entries(m).filter(([,v])=>v>0),den=Object.entries(m).filter(([,v])=>v<0);
 const term=([k,v])=>k+(Math.abs(v-1)<1e-12?'':'^'+fmtExp(v));
 if(!num.length&&!den.length)return '';
 if(!num.length)return den.map(([k,v])=>k+'^'+fmtExp(v)).join('*');
 const top=num.map(term).join('*');
 if(!den.length)return top;
 const bottom=den.map(([k,v])=>term([k,-v]));
 return top+'/'+(bottom.length>1?'('+bottom.join('*')+')':bottom[0]);
}
const fmtExp=v=>Number.isInteger(v)?String(v):String(+v.toFixed(4));

// Named SI units a result can be shown in, with the prefixes that read naturally.
const ALL=['T','G','M','k','','m','µ','n','p','f'],SMALL=['','m','µ','n','p','f'];
const NAMED=[
 ['m',[1,0,0,0,0,0,0],ALL.filter(p=>p!=='T'&&p!=='G'&&p!=='M')],['g',[0,1,0,0,0,0,0],['k','','m','µ','n']],['s',[0,0,1,0,0,0,0],SMALL],
 ['A',[0,0,0,1,0,0,0],['k','','m','µ','n','p']],['K',[0,0,0,0,1,0,0],SMALL],['mol',[0,0,0,0,0,1,0],['k','','m','µ','n']],['cd',[0,0,0,0,0,0,1],['']],
 ['Hz',[0,0,-1,0,0,0,0],['G','M','k','','m']],['N',[1,1,-2,0,0,0,0],ALL],['Pa',[-1,1,-2,0,0,0,0],['G','M','k','','m']],['J',[2,1,-2,0,0,0,0],ALL],
 ['W',[2,1,-3,0,0,0,0],ALL],['C',[0,0,1,1,0,0,0],['','m','µ','n','p']],['V',[2,1,-3,-1,0,0,0],ALL],['Ω',[2,1,-3,-2,0,0,0],['G','M','k','','m']],
 ['F',[-2,-1,4,2,0,0,0],['','m','µ','n','p']],['H',[2,1,-2,-2,0,0,0],['','m','µ','n']],['T',[0,1,-2,-1,0,0,0],['','m','µ','n']],['Wb',[2,1,-2,-1,0,0,0],['','m','µ']],
];
const FACTOR={T:1e12,G:1e9,M:1e6,k:1e3,'':1,m:1e-3,'µ':1e-6,n:1e-9,p:1e-12,f:1e-15};
const sameDim=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-10);
// The dimension written in SI base units (scale 1), e.g. kg*m^2/s^2.
function siString(dim){
 const names=['m','kg','s','A','K','mol','cd'];
 return formatAtoms(Object.fromEntries(dim.map((v,i)=>[names[i],v]).filter(([,v])=>Math.abs(v)>1e-12)))||'1';
}
// siMagnitude: a typical |value| of the result expressed in SI base units.
function suggestUnit(dim,siMagnitude,symbolic){
 const mag=Number.isFinite(siMagnitude)?Math.abs(siMagnitude):NaN;
 const inRange=(text,lo,hi)=>{try{const v=mag/U.parse(text).scale;return !(v>0)||v>=lo&&v<hi;}catch{return false;}};
 const dimensionless=dim.every(v=>Math.abs(v)<1e-12);
 if(symbolic){
  const keys=Object.keys(symbolic);
  if(keys.length===1&&Math.abs(symbolic[keys[0]]-1)<1e-12&&inRange(keys[0],1e-2,1e4))return keys[0];
  if(dimensionless)return formatAtoms(symbolic);
 }
 if(dimensionless)return '';
 const named=NAMED.find(([,d])=>sameDim(d,dim));
 if(named){
  const [unit,,prefixes]=named,base=unit==='g'?1e-3:1;
  if(!(mag>0))return prefixes.includes('')?unit:prefixes[0]+unit;
  const v=mag/base;
  const fits=prefixes.filter(p=>v/FACTOR[p]>=1&&v/FACTOR[p]<1000);
  if(fits.length)return fits[0]+unit;
  // Outside every allowed prefix: take the nearest end of the list.
  return (v>=1?prefixes[0]:prefixes[prefixes.length-1])+unit;
 }
 if(symbolic&&Object.keys(symbolic).length)return formatAtoms(symbolic);
 return siString(dim);
}
const api={symbolFor,unitAtoms,symbolicUnit,formatAtoms,siString,suggestUnit};
if(typeof module==='object')module.exports=api;else scope.CalcAssist=api;
})(globalThis);
