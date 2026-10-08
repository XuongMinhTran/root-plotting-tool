'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const ux=require('../frontend/fit-model.js');
const equation=require('../frontend/equation-parser.js');
test('guess display is short without changing the canonical value',()=>{
  const full='0.594750123456789';
  assert.equal(ux.formatGuess(full),'0.5948'); assert.equal(full,'0.594750123456789');
  assert.equal(ux.formatGuess('58720.912345'),'58720');
  assert.equal(ux.formatGuess('4.14123456789e-15'),'4.141e-15');
  assert.equal(ux.formatGuess(''),''); assert.equal(ux.formatGuess('invalid'),'invalid');
});
test('preview evaluates the supplied full precision guesses and active bounds',()=>{
  const curve=ux.previewModel(equation,'[0]*x+[1]',['slope','intercept'],['1.234567890123','-2.45678901234'],2,8);
  assert.equal(curve[0][1],1.234567890123*2-2.45678901234); assert.equal(curve.at(-1)[0],8);
  assert.throws(()=>ux.previewModel(equation,'[0]*x',['a'],[''],0,10),/Enter starting values/);
  assert.throws(()=>ux.previewModel(equation,'[0]*x',['a'],['1'],2,1),/fit range/);
});
test('domain failures produce gaps without fitting a different function',()=>{
  const curve=ux.previewModel(equation,'sqrt(x)+[0]',['a'],['2'],-2,2);
  assert.equal(curve[0][1],null); assert.equal(curve.at(-1)[1],Math.sqrt(2)+2);
  assert.throws(()=>ux.previewModel(equation,'landau',[],[],0,10));
  assert.throws(()=>ux.previewModel(equation,'[0]/0',['a'],['1'],0,10),/undefined/);
});
