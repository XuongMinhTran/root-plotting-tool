const assert=require('node:assert/strict');
const C=require('../frontend/analysis-core.js'),E=require('../frontend/equation-parser.js');
const near=(a,b)=>assert(Math.abs(a-b)<1e-7*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const fit={id:'fit',kind:'fit',parameters:[{name:'a',value:2,error:.2},{name:'b',value:3,error:.3}],covariance:[[.04,.03],[.03,.09]]};
const calc=(id,expression,bindings)=>({id,kind:'calculation',expression,bindings});
const sum=calc('sum','a+b',{a:{id:'fit',key:'0'},b:{id:'fit',key:'1'}});
let e=C.engine([fit,sum]);near(e.get('sum')[0].value,5);near(e.get('sum')[0].uncertainty,Math.sqrt(.19));
// Reusing the same uncertain source must cancel, not count uncertainty twice.
const diff=calc('difference','s-a-b',{s:{id:'sum',key:'value'},a:{id:'fit',key:'0'},b:{id:'fit',key:'1'}});
e=C.engine([fit,sum,diff]);near(e.get('difference')[0].value,0);near(e.get('difference')[0].uncertainty,0);
const data={id:'data',kind:'measurements',columns:[{name:'x',values:[1,2,3],errors:[.1,.1,.1]},{name:'y',values:[2,4,6]}]};
const transform=calc('twice','2 x',{x:{id:'data',key:'0'}});e=C.engine([data,transform]);near(e.get('twice')[2].value,6);near(e.get('twice')[2].uncertainty,.2);
const unknown=calc('unknown','x+y',{x:{id:'data',key:'0'},y:{id:'data',key:'1'}});assert.equal(C.engine([data,unknown]).get('unknown')[0].uncertainty,null);
const lifetime={id:'life',kind:'values',parameters:[{name:'tau',value:2.4,error:.08}]};
const half=calc('half','t\\ln(2)',{t:{id:'life',key:'0'}});e=C.engine([lifetime,half]);near(e.get('half')[0].value,2.4*Math.log(2));near(e.get('half')[0].uncertainty,.08*Math.log(2));
const changed=JSON.parse(JSON.stringify(lifetime));changed.parameters[0].value=4;near(C.engine([changed,half]).get('half')[0].value,4*Math.log(2));
assert.throws(()=>C.engine([{...fit,covariance:[[.04,.3],[.3,.09]]}]),/positive semidefinite/);
assert.throws(()=>C.engine([{...fit,covariance:[[.04,.03],[.02,.09]]}]),/symmetric/);
assert.throws(()=>C.engine([calc('loop','a',{a:{id:'loop',key:'value'}})]).get('loop'),/itself/);
assert.throws(()=>C.engine([calc('missing','a',{a:{id:'gone',key:'0'}})]).get('missing'),/missing/);
assert.throws(()=>E.expression('window.alert(1)'));
assert.throws(()=>E.expression('1/0').evaluate({}),/undefined/);
near(C.stats([1,2,3]).sd,1);assert.equal(C.stats([1]).sem,null);
// Imported fits and derived definitions are portable; results recalculate after reload.
const restored=JSON.parse(JSON.stringify([fit,sum,diff]));near(C.engine(restored).get('sum')[0].uncertainty,Math.sqrt(.19));
console.log('OK: covariance, shared-input cancellation, derived columns, missing errors, decay propagation, edits, invalid matrices, cycles, domain checks and round-trip.');
// Inline measured quantities propagate uncertainty and survive serialization.
const wave={id:'wavelength',kind:'calculation',expression:'d/(k*D)',bindings:{d:{literal:true,value:.25,error:.01,unit:'mm'},D:{literal:true,value:1000,error:2,unit:'mm'},k:{id:'fit',key:'0'}}};
const waveEngine=C.engine([fit,wave]);const waveResult=waveEngine.get('wavelength')[0];near(waveResult.value,.25/(2*1000));near(waveResult.uncertainty,waveResult.value*Math.sqrt((.01/.25)**2+(.2/2)**2+(2/1000)**2));
const cancelInline=calc('cancel-inline','w-w',{w:{id:'wavelength',key:'value'}});near(C.engine([fit,wave,cancelInline]).get('cancel-inline')[0].uncertainty,0);
near(C.engine(JSON.parse(JSON.stringify([fit,wave]))).get('wavelength')[0].value,waveResult.value);
assert.throws(()=>C.engine([{...wave,bindings:{d:{literal:true,value:1,error:-1}}}]),/nonnegative/);
console.log('OK: entered values, standard uncertainties, shared-source cancellation and saved inline quantities.');
