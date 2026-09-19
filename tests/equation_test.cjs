const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const E=require('../frontend/equation-parser.js');
// Evaluate only parser-generated expressions, with controlled test symbols.
function value(latex,x,p,previous=[]) {
 const r=E.compile(latex,previous);
 const js=r.formula.replace(/TMath::Pi\(\)/g,'Math.PI').replace(/\[(\d+)\]/g,(_,i)=>`p[${JSON.stringify(r.parameters[i])}]`).replace(/\^/g,'**').replace(/\b(exp|sin|cos|tan|sqrt|log|log10|abs|pow|atan2)\(/g,'Math.$1(');
 return Function('x','p',`return ${js}`)(x,p);
}
assert.equal(value('a x^2+b x+c',2,{a:2,b:3,c:4}),18);
assert.equal(value('-x^2',3,{}),-9);
assert.equal(value('2^{-3}',0,{}),0.125);
assert.equal(value('\\sin^2(x)+\\cos^2(x)',0.6,{}),1);
assert.equal(value('\\sqrt[3]{8}',0,{}),2);
assert.equal(value('\\frac{1}{2}x',6,{}),3);
assert.equal(value('y=A\\exp(-x/\\tau)+B',2,{A:10,tau:2,B:3}),10/Math.E+3);
assert.equal(value('x-x_0',7,{x_0:2}),5);
assert.equal(value('\\mathrm{background}+a x',2,{background:10,a:3}),16);
assert.equal(value('|x-3|',1,{}),2);
assert.equal(value('1.2\\times 10^{-3}',0,{}),.0012);
assert.deepEqual(E.compile('B+A x',['A','B']).parameters,['A','B']);
assert.deepEqual(E.compile('C+B',['A','B']).parameters,['B','C']);
for(const bad of ['','A+','\\frac{}{}','\\sin x','\\sin(x,2)','\\int x','A=2','x;alert(1)','x<2','1e999','\\unknown{x}','x_{}','x+\\placeholder{}','\\operatorname{unknown}(x)']) assert.throws(()=>E.compile(bad),undefined,bad);
for(const root of ['[0]*x+[1]','[0]*exp(-x/[1])+[2]','gausn','gaus(0)+pol0(3)','pol2','[0]*sin([1]*x+[2])+[3]']) {
 const r=E.fromRoot(root); assert(r.latex); assert(E.compile(r.latex,r.parameters).formula);
}
// ROOT imports must preserve numerical meaning and parameter identity.
for (const [root, expected] of [
 ['[0]*exp(-x/[1])+[2]', (x,a,b,c)=>a*Math.exp(-x/b)+c],
 ['[0]^(x+[1])', (x,a,b)=>a**(x+b)],
 ['sqrt((x-[0])^2+[1]^2)', (x,a,b)=>Math.sqrt((x-a)**2+b**2)],
 ['[0]/(x/([1]+[2]))', (x,a,b,c)=>a/(x/(b+c))],
 ['[0]-(x-([1]-[2]))', (x,a,b,c)=>a-(x-(b-c))],
 ['(-[0])^2+(1.2e-3)^2', (x,a)=>a*a+.0012**2],
 ['pol2', (x,a,b,c)=>a+b*x+c*x*x],
 ['gausn', (x,a,b,c)=>a/(Math.sqrt(2*Math.PI)*c)*Math.exp(-.5*((x-b)/c)**2)]
]) {
 const imported=E.fromRoot(root);
 assert.deepEqual(E.compile(imported.latex,imported.parameters).parameters,imported.parameters,root);
 for(const x of [.4,1.7,3]) {
  const actual=value(imported.latex,x,{a:2,b:3,c:4},imported.parameters);
  const want=expected(x,2,3,4);
  assert(Math.abs(actual-want)<1e-10*Math.max(1,Math.abs(want)),root+': '+imported.latex);
 }
}
for(const root of ['landau','TMath::Landau(x,[0],[1])','x<[0]?[1]:[2]','[name]*x','x[1]+[0]','y+[0]']) {
 // x[1] is reserved below as a ROOT multidimensional variable; the importer must refuse it.
 assert.throws(()=>E.fromRoot(root),undefined,root);
}
const elements=new Map();
const el=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,textContent:'',listeners:{},setAttribute(){},focus(){},setValue(v){this.value=v},addEventListener(e,f){this.listeners[e]=f},querySelectorAll(){return[]}});return elements.get(id)};
const document={getElementById:el,dispatchEvent(){}};
const window={RootEquation:E,MathfieldElement:class{}};
const ctx=vm.createContext({window,MathfieldElement:window.MathfieldElement,document,Event:class{},syncDatasetFit(){},renderParamTable(){window.RootEquationEditor.sync()},autosave(){},askDialog:async()=>true});
vm.runInContext(fs.readFileSync('frontend/equation-editor.js','utf8'),ctx);
const editor=window.RootEquationEditor;
const read=()=>JSON.parse(JSON.stringify(editor.snapshot()));
function edit(latex){el('fit-equation').value=latex;el('fit-equation').listeners.input();}
el('formula').value='[0]*x+[1]';el('param-names').value='slope, intercept';el('initial-guesses').value='2, 3';
editor.load({});assert.equal(read().mode,'equation');
edit('\\mathrm{intercept}+\\mathrm{slope} x');
assert.deepEqual(read().parameters,['slope','intercept']);assert.equal(el('initial-guesses').value,'2, 3');
edit('\\mathrm{intercept}+');assert.throws(()=>editor.validate(),/Complete/);assert.equal(el('formula').value,'');
const draft=read();editor.load({equation:draft});assert.equal(read().latex,draft.latex);assert.throws(()=>editor.validate());
edit('\\mathrm{intercept}+\\mathrm{slope} x');assert.equal(el('initial-guesses').value,'2, 3');
el('param-names').value='gradient, offset';el('initial-guesses').value='5, 8';
edit('\\mathrm{slope} x');assert.equal(el('initial-guesses').value,'5');
edit('\\mathrm{slope} x+\\mathrm{intercept}');assert.equal(el('initial-guesses').value,'5, 8');assert.equal(el('param-names').value,'gradient, offset');
const saved=read();el('formula').value='[0]*x';editor.load({});edit('c x');
el('formula').value=saved.formula;el('param-names').value='gradient, offset';el('initial-guesses').value='5, 8';editor.load({equation:saved});assert.deepEqual(read().parameters,['slope','intercept']);
el('formula').value='landau';editor.fromRoot();assert.equal(read().mode,'root');assert.equal(el('formula').value,'landau');
console.log('OK: numerical semantics, stable parameter order and guesses, rejected syntax, ROOT presets, saved drafts, dataset restoration and raw fallback.');

// Reverse conversion updates the actual ROOT input and preview as the user types.
el('formula').value='[0]*x+[1]';el('param-names').value='a, b';editor.load({});
edit('a x^2+b');
assert.equal(el('formula').value,E.compile('a x^2+b',['a','b']).formula);
assert.equal(el('equation-root-preview').textContent,el('formula').value);
// A pending committed edit is flushed before revealing ROOT mode.
el('fit-equation').value='a x^3+b';
el('equation-mode').listeners.change({target:{name:'equation-mode',value:'root'}});
assert.equal(read().mode,'root');
assert.equal(el('formula').value,E.compile('a x^3+b',['a','b']).formula);
assert.equal(el('equation-root').hidden,false);
el('equation-mode').listeners.change({target:{name:'equation-mode',value:'equation'}});
assert.equal(el('fit-equation').value,'a x^3+b');
el('fit-equation').value='a x^4+b';el('fit-equation').listeners.change();
assert.equal(el('formula').value,E.compile('a x^4+b',['a','b']).formula);
console.log('OK: equation edits update ROOT input and preview, commit on change, and survive mode switches.');
