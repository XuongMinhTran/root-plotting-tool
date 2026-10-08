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
  assert.throws(()=>ux.previewModel(equation,'[0]*x',['a'],[''],0,10),/Enter or estimate starting values/);
  assert.throws(()=>ux.previewModel(equation,'[0]*x',['a'],['1'],2,1),/fit range/);
});
test('domain failures produce gaps without fitting a different function',()=>{
  const curve=ux.previewModel(equation,'sqrt(x)+[0]',['a'],['2'],-2,2);
  assert.equal(curve[0][1],null); assert.equal(curve.at(-1)[1],Math.sqrt(2)+2);
  assert.throws(()=>ux.previewModel(equation,'landau',[],[],0,10));
  assert.throws(()=>ux.previewModel(equation,'[0]/0',['a'],['1'],0,10),/undefined/);
});
test('button adjustments support scientific scales, zero crossings and sign changes',()=>{
  assert.equal(ux.adjustGuess(0,1e-12,'plus'),1e-12);
  assert.equal(ux.adjustGuess(1,2,'minus'),-1);
  assert.equal(ux.adjustGuess(-3,1,'sign'),3);
  assert.equal(ux.adjustGuess(1.234567890123,1e-12,'plus'),1.234567890123+1e-12);
});
test('unrepresentable adjustments and invalid steps cannot silently replace guesses',()=>{
  for(const step of [0,-1,NaN,Infinity]) assert.throws(()=>ux.adjustGuess(1,step,'plus'),/Step/);
  assert.throws(()=>ux.adjustGuess(NaN,1,'plus'),/finite/);
  assert.throws(()=>ux.adjustGuess(1e30,1,'plus'),/too small/);
  assert.throws(()=>ux.adjustGuess(Number.MAX_VALUE,Number.MAX_VALUE,'plus'),/number range/);

});
test('step magnitude changes independently before the next plus or minus',()=>{
  const value=3.141592653589793, step=1e-12;
  const larger=ux.scaleStep(step,'times10');
  assert.equal(larger,step*10);
  assert.equal(ux.scaleStep(larger,'divide10'),larger/10);
  assert.equal(ux.adjustGuess(value,larger,'plus'),value+larger);
  for(const invalid of [0,-1,NaN,Infinity]) assert.throws(()=>ux.scaleStep(invalid,'times10'),/Step/);
  assert.throws(()=>ux.scaleStep(Number.MAX_VALUE,'times10'),/number range/);
  assert.throws(()=>ux.scaleStep(Number.MIN_VALUE,'divide10'),/number range/);
});

test('default adjustment scales contain the current guess across orders of magnitude',()=>{
  for(const value of [0,1e-200,-1e-12,1,-500,1e200,Number.MIN_VALUE,-Number.MAX_VALUE,Number.MAX_VALUE]) {
    const linear=ux.defaultAdjustment(value);
    assert.ok(linear.step>0 && Number.isFinite(linear.step));
    assert.ok(Number.isFinite(linear.low) && Number.isFinite(linear.high));
    assert.ok(linear.low<linear.high && linear.low<=value && linear.high>=value);
    const log=ux.defaultAdjustment(value,'log'), magnitude=Math.abs(value)||1;
    assert.ok(log.low>0 && log.low<log.high && log.low<=magnitude && log.high>=magnitude);
  }
});
test('linear sliders span signed ranges and retain finite extreme endpoints',()=>{
  assert.equal(ux.sliderValue(.5,-5,5),0);
  assert.equal(ux.sliderPosition(0,-5,5),.5);
  assert.equal(ux.sliderValue(.5,-Number.MAX_VALUE,Number.MAX_VALUE),0);
  assert.equal(ux.sliderPosition(0,-Number.MAX_VALUE,Number.MAX_VALUE),.5);
  assert.equal(ux.sliderValue(1,0,Number.MAX_VALUE),Number.MAX_VALUE);
  assert.throws(()=>ux.sliderValue(.5,5,1),/range/);
});
test('logarithmic sliders move by magnitude while preserving negative signs',()=>{
  assert.equal(ux.sliderValue(.5,1e-12,1e-6,'log',-1),-1e-9);
  assert.equal(ux.sliderPosition(-1e-9,1e-12,1e-6,'log'),.5);
  assert.equal(ux.sliderValue(0,Number.MIN_VALUE,Number.MAX_VALUE,'log'),Number.MIN_VALUE);
  assert.equal(ux.sliderValue(1,Number.MIN_VALUE,Number.MAX_VALUE,'log',-1),-Number.MAX_VALUE);
  assert.throws(()=>ux.sliderValue(.5,0,1,'log'),/positive/);
});
test('starting-value provenance survives equivalent numeric formatting',()=>{
  const signature='data-and-model';
  const saved={source:'automatic',values:ux.valuesKey('1e-9, 2.12345678901234'),signature};
  assert.match(ux.startingStatus('0.000000001, 2.12345678901234',2,saved,signature).text,/Estimated from your data/);
  assert.match(ux.startingStatus('1e-9, 2.12345678901235',2,saved,signature).text,/Starting values set/);
  assert.match(ux.startingStatus('1e-9, 2.12345678901234',2,saved,'changed-data').text,/changed.*re-estimate/);
});
test('starting-value status distinguishes manual sources and incomplete values',()=>{
  for(const [source,label] of [['adjusted','Adjusted manually'],['edited','Edited']]) {
    assert.match(ux.startingStatus('1, 2',2,{source,values:ux.valuesKey('1, 2'),signature:'same'},'same').text,new RegExp(label));
  }
  for(const values of ['1,','1, bad','1, Infinity']) {
    const state=ux.startingStatus(values,2,null,'same'); assert.equal(state.ready,false); assert.match(state.text,/incomplete/);
  }
  assert.match(ux.startingStatus('',2,null,'same').text,/model defaults/);
});
