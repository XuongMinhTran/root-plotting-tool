/* Bounded multiplicative-unit grammar and dimensional checks; no code evaluation. */
(function(scope){
'use strict';
const fail=m=>{throw Error(m);}, zero=()=>Array(7).fill(0);
const make=(scale=1,dim=zero())=>({scale,dim});
const same=(a,b)=>a.dim.every((v,i)=>Math.abs(v-b.dim[i])<1e-10);
const mul=(a,b,sign=1)=>make(a.scale*b.scale**sign,a.dim.map((v,i)=>v+sign*b.dim[i]));
const pow=(a,n)=>make(a.scale**n,a.dim.map(v=>v*n));
const defs={};
function def(names,scale,d){for(const n of names.split(' '))defs[n]=make(scale,d);}
def('m',1,[1,0,0,0,0,0,0]);def('kg',1,[0,1,0,0,0,0,0]);def('g',.001,[0,1,0,0,0,0,0]);def('s',1,[0,0,1,0,0,0,0]);def('A',1,[0,0,0,1,0,0,0]);def('K deltaK',1,[0,0,0,0,1,0,0]);def('mol',1,[0,0,0,0,0,1,0]);def('cd',1,[0,0,0,0,0,0,1]);
def('rad sr count counts',1,zero());def('deg',Math.PI/180,zero());def('Hz Bq',1,[0,0,-1,0,0,0,0]);def('N',1,[1,1,-2,0,0,0,0]);def('Pa',1,[-1,1,-2,0,0,0,0]);def('J',1,[2,1,-2,0,0,0,0]);def('W',1,[2,1,-3,0,0,0,0]);def('C',1,[0,0,1,1,0,0,0]);def('V',1,[2,1,-3,-1,0,0,0]);def('ohm Ω',1,[2,1,-3,-2,0,0,0]);def('S',1,[-2,-1,3,2,0,0,0]);def('F',1,[-2,-1,4,2,0,0,0]);def('H',1,[2,1,-2,-2,0,0,0]);def('T',1,[0,1,-2,-1,0,0,0]);def('Wb',1,[2,1,-2,-1,0,0,0]);def('eV',1.602176634e-19,[2,1,-2,0,0,0,0]);def('L l',.001,[3,0,0,0,0,0,0]);def('min',60,[0,0,1,0,0,0,0]);def('h',3600,[0,0,1,0,0,0,0]);
const prefixes={da:1e1,Y:1e24,Z:1e21,E:1e18,P:1e15,T:1e12,G:1e9,M:1e6,k:1e3,h:1e2,d:1e-1,c:1e-2,m:1e-3,u:1e-6,µ:1e-6,μ:1e-6,n:1e-9,p:1e-12,f:1e-15,a:1e-18};
function atom(name){if(defs[name])return defs[name];for(const [p,s] of Object.entries(prefixes))if(name.startsWith(p)&&defs[name.slice(p.length)]&&!['kg','min','h','counts','count','deg','deltaK'].includes(name.slice(p.length)))return make(s*defs[name.slice(p.length)].scale,defs[name.slice(p.length)].dim);fail('Unsupported unit “'+name+'”. Use multiplicative units such as mm, cm, mm^-1, or J/(mol*K). Celsius, Fahrenheit, and decibels are not supported.');}
function parse(text){
 text=String(text||'').trim().replace(/[·⋅]/g,'*').replace(/−/g,'-');if(!text)fail('Specify a unit for every input and the result. Enter 1 for a dimensionless quantity.');if(text.length>200)fail('The unit expression is too long.');
 const tokens=text.match(/[A-Za-zµμΩ]+|(?:\d+(?:\.\d*)?|\.\d+)|[*/^()+-]|\S/g)||[];let i=0;
 function primary(){let u;if(tokens[i]==='('){i++;u=product();if(tokens[i++]!==')')fail('Close the parentheses in the unit.');}else{const t=tokens[i++];u=t==='1'?make():atom(t||'');}if(tokens[i]==='^'){i++;let bracket=tokens[i]==='(';if(bracket)i++;let sign=1;if(tokens[i]==='-'){sign=-1;i++;}else if(tokens[i]==='+')i++;let n=Number(tokens[i++])*sign;if(bracket&&tokens[i]==='/'){i++;n/=Number(tokens[i++]);}if(!Number.isFinite(n)||Math.abs(n)>100)fail('Use a finite numerical unit exponent between -100 and 100.');if(bracket&&tokens[i++]!==')')fail('Close the unit exponent parentheses.');u=pow(u,n);}return u;}
 function product(){let u=primary();while(i<tokens.length&&tokens[i]!==')'){let sign=1;if(tokens[i]==='/'||tokens[i]==='*')sign=tokens[i++]==='/'?-1:1;u=mul(u,primary(),sign);}return u;}
 const u=product();if(i!==tokens.length||!Number.isFinite(u.scale)||u.scale<=0)fail('Invalid unit expression.');return u;
}
function dimension(ast,units){
 const one=make();const compatible=(a,b)=>{if(!same(a,b))fail('Incompatible dimensions in addition, subtraction, or comparison. Check the assigned units.');return a;};
 function constant(a){if(a.k==='number')return Number(a.v);if(a.k==='constant')return a.v==='pi'?Math.PI:Math.E;if(a.k==='unary')return(a.op==='-'?-1:1)*constant(a.a);if(a.k==='binary'){const l=constant(a.a),r=constant(a.b);return a.op==='+'?l+r:a.op==='-'?l-r:a.op==='*'?l*r:a.op==='/'?l/r:l**r;}fail('A dimensional quantity requires a constant numerical exponent.');}
 function power(a,b){const d=walk(a),e=walk(b);if(!same(e,one))fail('An exponent must be dimensionless.');return same(d,one)?one:pow(d,constant(b));}
 function walk(a){if(a.k==='number'||a.k==='constant')return one;if(a.k==='symbol')return units[a.v];if(a.k==='unary')return walk(a.a);if(a.k==='binary'){if(a.op==='^')return power(a.a,a.b);const l=walk(a.a),r=walk(a.b);return a.op==='*'?mul(l,r):a.op==='/'?mul(l,r,-1):compatible(l,r);}
 if(a.v==='pow')return power(...a.args);const ds=a.args.map(walk);if(a.v==='atan2'){compatible(ds[0],ds[1]);return one;}if(a.v==='sqrt')return pow(ds[0],.5);if(a.v==='abs')return ds[0];if(a.v==='min'||a.v==='max')return ds.reduce(compatible);if(ds.some(d=>!same(d,one)))fail(a.v+' requires dimensionless arguments (angles may use rad or deg).');return one;}
 return walk(ast);
}
const api={parse,same,dimension};if(typeof module==='object')module.exports=api;else scope.AnalysisUnits=api;
})(globalThis);
