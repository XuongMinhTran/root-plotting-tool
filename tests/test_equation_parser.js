'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const equation=require('../frontend/equation-parser.js');
const library=JSON.parse(fs.readFileSync(path.join(__dirname,'../frontend/model-library.js'),'utf8')
  .match(/const DATA = ([\s\S]*?);\s*const norm/)[1]);
const model=library.models.find(m=>m.name==='Double-slit (Gaussian fringe visibility)');
const names=model.params.split(',').map(s=>s.trim());

test('nine-parameter library model imports and retains parameter identities',()=>{
  const imported=equation.fromRoot(model.formula,names);
  assert.match(imported.latex,/\\operatorname\{sinc\}/);
  assert.deepEqual(imported.parameters,names);
  const compiled=equation.compile(imported.latex,imported.parameters);
  assert.deepEqual(compiled.parameters,names);
  assert.deepEqual(equation.fromRoot(compiled.formula,names).parameters,names);
});

test('the displayed model equals the physical equation at and around its center',()=>{
  const expression=equation.expression(equation.fromRoot(model.formula,names).latex);
  for(const parameters of [[400,7,1.3,4.1,.2,.7,.8,1.3,2.4],[400,7,0,4.1,.2,.7,0,1.3,2.4]]) {
    const [n0,bg,ka,kd,x1,x0,v,xc,w]=parameters;
    for(const x of [-2,x1-1e-10,x1,x1+1e-10,2]) {
      const z=ka*(x-x1), envelope=z===0?1:(Math.sin(z)/z)**2;
      const expected=bg+n0/2*envelope*(1+v*Math.exp(-(((x-xc)/w)**2))*Math.cos(2*kd*(x-x0)));
      const actual=expression.evaluate({...Object.fromEntries(names.map((n,i)=>[n,parameters[i]])),x});
      assert.ok(Math.abs(actual-expected)<1e-9,`${x}: ${actual} versus ${expected}`);
    }
  }
});

test('sinc is unnormalized, finite at zero, and keeps its guard when compiled',()=>{
  const compiled=equation.compile('sinc(x)');
  assert.match(compiled.formula,/==0\?1:sin/);
  assert.deepEqual(equation.fromRoot(compiled.formula).parameters,[]);
  const calc=equation.expression('sinc(x)');
  assert.equal(calc.evaluate({x:0}),1);
  assert.ok(Math.abs(calc.evaluate({x:Math.PI}))<1e-15);
  assert.throws(()=>equation.compile('sinc(x, 1)'),/takes 1 argument/);
});

test('only equivalent guarded sinc expressions can be imported',()=>{
  for(const formula of ['(x==0?1:sin(x)/x)','((x)==0 ? 1 : TMath::Sin(x)/(x))','(x==0?1:pow(sin(x)/x,2))']) {
    assert.match(equation.fromRoot(formula).latex,/sinc/);
  }
  for(const formula of ['(x==0?1:sin(x)/(x+1))','(x==0?0:sin(x)/x)','(x==0?1:pow(sin(x)/x,3))','(x>0?sin(x):cos(x))']) {
    assert.throws(()=>equation.fromRoot(formula));
  }
});

test('all library models still import and round-trip through the editor',()=>{
  for(const m of library.models) {
    const imported=equation.fromRoot(m.formula,m.params.split(',').map(s=>s.trim()));
    const compiled=equation.compile(imported.latex,imported.parameters);
    assert.deepEqual(compiled.parameters,imported.parameters,m.name);
    assert.deepEqual(equation.fromRoot(compiled.formula,compiled.parameters).parameters,compiled.parameters,m.name);
  }
});

test('existing arithmetic and parameter order remain stable',()=>{
  assert.deepEqual(equation.compile('v_{terminal} + k_{scale}*x').parameters,['v_terminal','k_scale']);
  assert.deepEqual(equation.compile('b + a*x',['a','b']).parameters,['a','b']);
  assert.equal(equation.expression('-x^2').evaluate({x:3}),-9);
  assert.equal(equation.expression('pow(x,2)+cos(0)').evaluate({x:3}),10);
  assert.throws(()=>equation.compile('sinc(window.alert(1))'));
});
