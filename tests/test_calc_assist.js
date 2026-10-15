'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const A=require('../frontend/calc-assist.js');
const E=require('../frontend/equation-parser.js');
const U=require('../frontend/units.js');

test('sources get the symbol a physicist would write',()=>{
 assert.equal(A.symbolFor('Lifetime'),'L');
 assert.equal(A.symbolFor('tau'),'tau');
 assert.equal(A.symbolFor('N0'),'N_0');
 assert.equal(A.symbolFor('k_a'),'k_a');
 assert.equal(A.symbolFor('count_scale'),'c_s');
 assert.equal(A.symbolFor('envelope_scale'),'E_s');          // e is Euler's number
 assert.equal(A.symbolFor('x'),'x');
 assert.equal(A.symbolFor('mean'),'m');
 assert.equal(A.symbolFor('p1'),'p_1');
 assert.equal(A.symbolFor('Half-life'),'H');
 assert.equal(A.symbolFor('t (s)'),'t');
 assert.equal(A.symbolFor('Bin counts'),'B_c');
 assert.equal(A.symbolFor('Amplitude','N_0'),'N_0');          // the fit's own symbol wins
 assert.equal(A.symbolFor('Amplitude','not valid!'),'A');
 assert.equal(A.symbolFor('Length',null,new Set(['L','L_2'])),'L_3');
 assert.equal(A.symbolFor('count_scale',null,new Set(['c_s'])),'c_s2');
 for(const s of ['L','N_0','c_s2','tau','E_s','p_1'])assert.deepEqual(E.expression(E.symbolLatex(s)).variables,[s]);
});

test('unit names combine through the expression',()=>{
 const sym=(latex,units)=>{const ex=E.expression(latex);return A.symbolicUnit(ex.ast,Object.fromEntries(Object.entries(units).map(([k,u])=>[k,A.unitAtoms(u)])));};
 assert.deepEqual(sym('\\tau\\ln(2)',{tau:'s'}),{s:1});
 assert.deepEqual(sym('\\frac{V}{I}',{V:'V',I:'A'}),{V:1,A:-1});
 assert.deepEqual(sym('\\frac{a-b}{a+b}',{a:'counts',b:'counts'}),{});
 assert.equal(sym('a+b',{a:'mm',b:'cm'}),null);
 assert.deepEqual(sym('\\sqrt{x}',{x:'m^2'}),{m:1});
 assert.equal(A.formatAtoms({m:1,s:-2}),'m/s^2');
 assert.equal(A.formatAtoms({J:1,mol:-1,K:-1}),'J/(mol*K)');
 assert.equal(A.formatAtoms({s:-1}),'s^-1');
 assert.equal(A.unitAtoms('nonsense)'),null);
});

test('the suggested result unit reads naturally and parses',()=>{
 const L=[1,0,0,0,0,0,0],T=[0,0,1,0,0,0,0],none=[0,0,0,0,0,0,0];
 assert.equal(A.suggestUnit(T,1.66,{s:1}),'s');
 assert.equal(A.suggestUnit(T,0.00166,{s:1}),'ms');                 // out of range for s: prefix by size
 assert.equal(A.suggestUnit(L,5.3e-7,{mm:2,cm:-1}),'nm');            // wavelength from mm and cm inputs
 assert.equal(A.suggestUnit(L,0.004,{mm:1}),'mm');
 assert.equal(A.suggestUnit([1,0,-1,0,0,0,0],3,{m:1,s:-1}),'m/s');
 assert.equal(A.suggestUnit([1,0,-2,0,0,0,0],9.8,null),'m/s^2');
 assert.equal(A.suggestUnit(none,0.5,{}),'');
 assert.equal(A.suggestUnit(none,200,{counts:1}),'counts');
 assert.equal(A.suggestUnit([2,1,-3,-2,0,0,0],1500,{V:1,A:-1}),'kΩ');
 assert.equal(A.suggestUnit([0,1,0,0,0,0,0],0.25,null),'g');
 assert.equal(A.suggestUnit([0,1,0,0,0,0,0],2.5,null),'kg');
 for(const u of ['ms','nm','m/s','kΩ','µm','J/(mol*K)','s^-1'])assert.ok(U.parse(u).scale>0);
 assert.equal(A.siString([2,1,-2,0,0,0,0]),'m^2*kg/s^2');
 assert.equal(A.siString(none),'1');
});
