'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const sv=require('../frontend/setup-view.js');

const XY=[
  {id:'x',label:'X',kind:'value'},{id:'y',label:'Y',kind:'value'},
  {id:'ex',label:'X uncertainty',of:'x',kind:'unc',modeKey:'ex'},{id:'ey',label:'Y uncertainty',of:'y',kind:'unc',modeKey:'ey'},
];

test('column text splits into aligned cells and joins back one value per line',()=>{
  assert.deepEqual(sv.splitCells(''),[]);
  assert.deepEqual(sv.splitCells('1\n\n3\n'),['1','','3']);
  assert.deepEqual(sv.splitCells('1, 2, 3'),['1','2','3']);
  assert.equal(sv.joinCells(['1','','3','',''],3),'1\n\n3');
  assert.equal(sv.joinCells(['','',''],3),'');
});

test('uncertainty mode follows a stored choice only while it still fits the text',()=>{
  assert.equal(sv.resolveMode(undefined,'',0,'per-point',false),'per-point');   // new dataset: column default
  assert.equal(sv.resolveMode(undefined,'',5,'per-point',true),'none');          // data without errors
  assert.equal(sv.resolveMode(undefined,'0.2',5,'none',true),'constant');        // one value for every point
  assert.equal(sv.resolveMode(undefined,'0.2\n0.3',2,'none',true),'per-point');
  assert.equal(sv.resolveMode('per-point','0.2',5,'none',true),'per-point');     // explicit choice kept
  assert.equal(sv.resolveMode('none','0.2\n0.3',2,'none',true),'per-point');     // edited elsewhere: text wins
  assert.equal(sv.resolveMode('constant','',5,'none',true),'constant');
});

test('a pasted header is detected and matched by name, including uncertainty spellings',()=>{
  const block=sv.parseBlock('x\ty\tsigma_y\n1\t2\t0.1\n2\t4\t0.2');
  assert.deepEqual(block.header,['x','y','sigma_y']);
  assert.equal(block.rows.length,2);
  assert.deepEqual(sv.matchHeader(['X','Y','u(x)','dy'],XY),[0,1,2,3]);
  assert.deepEqual(sv.matchHeader(['y','x uncertainty'],XY),[1,2]);
  assert.equal(sv.matchHeader(['time','y'],XY),null);
  assert.equal(sv.parseBlock('1\t2\n3\t4').header,null);
});

test('paste fills open columns first and only widens into Constant or None columns when needed',()=>{
  const editable=[true,true,false,true];               // X unc None, Y unc Per point
  assert.deepEqual(sv.pasteTargets(XY,editable,0,3,null),{targets:[0,1,3],enable:[]});
  assert.deepEqual(sv.pasteTargets(XY,editable,0,4,null),{targets:[0,1,2,3],enable:[2]});
  assert.deepEqual(sv.pasteTargets(XY,editable,1,1,null),{targets:[1],enable:[]});
  assert.deepEqual(sv.pasteTargets(XY,editable,0,3,['x','y','ex']),{targets:[0,1,2],enable:[2]});
});

test('validation flags missing values, gaps in a Per point column and bad constants',()=>{
  const modes={ex:'constant',ey:'per-point'};
  const rows=[['1','2','','0.1'],['2','','','0.2'],['3','6','',''],['','','','']];
  const v=sv.validateRows(rows,XY,modes,{ex:''});
  assert.deepEqual(v.filled,[0,1,2]);
  assert.ok(v.bad.has('1:1') && v.bad.has('2:3'));
  const messages=v.issues.map(i=>i.msg);
  assert.ok(messages.includes('Row 2 needs a Y value'));
  assert.ok(messages.some(m=>/Y uncertainty is missing on row 3/.test(m)));
  assert.ok(messages.includes('Enter the constant X uncertainty'));
  assert.ok(v.issues.find(i=>/missing on/.test(i.msg)).partial);
  const ok=sv.validateRows([['1','2','','0.1'],['2','4','','0.1']],XY,{ex:'none',ey:'per-point'},{});
  assert.equal(ok.issues.length,0);
  const negative=sv.validateRows([['1','2','','-1']],XY,{ex:'none',ey:'per-point'},{});
  assert.match(negative.issues[0].msg,/size/);
});

test('pre-binned rows produce contiguous edges and report gaps',()=>{
  const rows=[['0','1','5'],['1','','7'],['2','3','4']];
  const bins=sv.binsFromRows(rows,[0,1,2]);
  assert.deepEqual(bins.edges,['0','1','2','3']);
  assert.deepEqual(bins.counts,['5','7','4']);
  assert.equal(bins.problems.length,0);
  const gap=sv.binsFromRows([['0','1','5'],['1.5','2','7']],[0,1]);
  assert.match(gap.problems[0].msg,/Bins must touch/);
  const open=sv.binsFromRows([['0','1','5'],['1','','7']],[0,1]);
  assert.match(open.problems[0].msg,/needs the value where its bin ends/);
});

test('sample histograms follow the backend binning rule',()=>{
  const h=sv.histogramFromSamples([0.2,1.5,1.7,2.9]);
  assert.deepEqual(h.edges.map(e=>+e.toFixed(6)),[0.2,1.1,2,2.9]);   // ceil(2.7) = 3 bins across min..max, like numpy.linspace
  assert.equal(h.counts.reduce((a,b)=>a+b),4);
  const custom=sv.histogramFromSamples([0.5,1.5,3],{edges:'0 1 2 4'});
  assert.deepEqual(custom.counts,[1,1,1]);
  const fixed=sv.histogramFromSamples([1,2,3,4],{bins:'2',min:'0',max:'4'});
  assert.deepEqual(fixed.counts,[1,3]);                // the last edge is inclusive
  assert.equal(sv.histogramFromSamples([]),null);
});

test('tick values are round and cover the range',()=>{
  const {ticks,step}=sv.niceTicks(0.6,8.4,5);
  assert.equal(step,2); assert.deepEqual(ticks,[2,4,6,8]);
  assert.equal(sv.fmtTick(0.25,0.05),'0.25');
  assert.ok(sv.niceTicks(3,3).ticks.length>0);
});

test('the preview moves below once the grid needs the width',()=>{
  const narrow=sv.gridMinWidth(XY);
  const mv=sv.gridMinWidth([...Array(4)].map(()=>({kind:'value'})).concat([...Array(4)].map(()=>({kind:'unc'}))));
  assert.ok(narrow<700); assert.ok(mv>1100);
});

test('column order is display only and survives added or removed columns',()=>{
  const cols=['x','y','ex','ey'].map(id=>({id}));
  assert.deepEqual(sv.resolveOrder(cols,undefined),[0,1,2,3]);
  assert.deepEqual(sv.resolveOrder(cols,['x','ex','y','ey']),[0,2,1,3]);
  assert.deepEqual(sv.resolveOrder(cols,['ey','gone','x']),[3,0,1,2]);       // unknown ids dropped, missing ones placed after their neighbour
  const mv=['in0','in1','in2','out0'].map(id=>({id}));
  assert.deepEqual(sv.resolveOrder(mv,['in1','in0','out0']),[1,0,2,3]);      // a new input lands next to the previous one
  assert.deepEqual(sv.moveColumn([0,1,2,3],3,1),[0,3,1,2]);
  assert.deepEqual(sv.moveColumn([0,1,2,3],0,3),[1,2,3,0]);
  assert.deepEqual(sv.moveColumn([0,1,2,3],2,9),[0,1,3,2]);
});

test('pasting follows the order shown',()=>{
  const editable=[true,true,false,true];
  // X, X unc, Y, Y unc on screen; X unc is None
  assert.deepEqual(sv.pasteTargets(XY,editable,0,3,null,[0,2,1,3]),{targets:[0,1,3],enable:[]});
  assert.deepEqual(sv.pasteTargets(XY,editable,0,4,null,[0,2,1,3]),{targets:[0,2,1,3],enable:[2]});
  // Y unc moved before Y: pasting two columns from Y uncertainty fills Y uncertainty, then Y
  assert.deepEqual(sv.pasteTargets(XY,editable,3,2,null,[0,3,1,2]),{targets:[3,1],enable:[]});
});
