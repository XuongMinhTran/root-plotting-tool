const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const requests = [], downloads = [], messages = [], storage = new Map();
let replies = [];
const context = vm.createContext({TextEncoder, console, setTimeout(){return 1;}, clearTimeout(){}, window:{addEventListener(){}},
  document:{getElementById:()=>({value:'Decay experiment'})},
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
  dialogStub: async options => {requests.push(options); return replies.shift();},
  recordDownload:(...args)=>downloads.push(args), recordMessage:(...args)=>messages.push(args),
});
vm.runInContext(fs.readFileSync('frontend/app.js','utf8').replace(/\ninit\(\);\s*$/,''),context);
vm.runInContext(`askDialog=dialogStub; downloadText=recordDownload; showMessage=recordMessage;
  buildDocument=()=>({version:1,title:'Test analysis',inputs:{x:[1,2],y:[2,4]}});`,context);
const run = code => vm.runInContext(code,context);
(async () => {
  run('globalThis.loadedExample=null; globalThis.exampleSaves=0; applyDocument=d=>{loadedExample=d}; autosave=()=>{exampleSaves++}');
  replies=[false]; await run("loadExample('linear')");
  assert.equal(run('loadedExample'),null); assert.equal(run('exampleSaves'),0);
  assert.equal(requests.at(-1).accept,'Continue'); assert.equal(requests.at(-1).cancel,'Cancel');
  replies=[true]; await run("loadExample('linear')");
  assert.equal(run('loadedExample.title'),run('EXAMPLES.linear.title')); assert.equal(run('exampleSaves'),1);
  assert.equal(run("documentFilename('  Decay run 2  ')"),'Decay run 2.json');
  assert.equal(run("documentFilename('decay.JSON')"),'decay.JSON');
  for (const name of ['', '..', '../run', 'bad:name', 'CON.json', 'run.', 'x'.repeat(241)]) {
    assert.throws(()=>run(`documentFilename(${JSON.stringify(name)})`));
  }
  replies=[null]; await run('saveDocument()'); assert.equal(downloads.length,0);
  replies=['run.json']; await run('saveDocument()'); assert.equal(downloads.length,1);
  assert.equal(downloads[0][1],'run.json'); assert.equal(JSON.parse(downloads[0][0]).version,1);
  replies=['run.json',null]; await run('saveDocument()'); assert.equal(downloads.length,1);
  assert.equal(requests.at(-1).title,'Download another copy');
  replies=['run.json',true]; await run('saveDocument()'); assert.equal(downloads.length,2);
  assert.match(messages.at(-1)[1],/Download requested/);

  let writes=0,closed=0,aborted=0,created=0,oldSize=20;
  const handle={name:'selected.json',getFile:async()=>({size:oldSize}),createWritable:async()=>{
    created++; return {write:async text=>{assert.equal(JSON.parse(text).title,'Test analysis');writes++;},close:async()=>closed++,abort:async()=>aborted++};
  }};
  context.window.showSaveFilePicker=async options=>{assert.equal(options.suggestedName,'run.json');return handle;};
  replies=['run.json',null]; await run('saveDocument()'); assert.equal(created,0);
  assert.equal(requests.at(-1).title,'Replace file');
  replies=['run.json',true]; await run('saveDocument()'); assert.equal(writes,1); assert.equal(closed,1);
  assert.match(messages.at(-1)[1],/Saved “selected.json”/);
  oldSize=0; replies=['run.json']; await run('saveDocument()'); assert.equal(writes,2);
  context.window.showSaveFilePicker=async()=>{const error=new Error('Canceled');error.name='AbortError';throw error;};
  replies=['run.json']; const oldMessages=messages.length; await run('saveDocument()');assert.equal(messages.length,oldMessages);
  assert.equal(run('savingDocument'),false);
  context.window.showSaveFilePicker=async()=>({...handle,createWritable:async()=>({write:async()=>{throw Error('Disk full');},close:async()=>closed++,abort:async()=>aborted++})});
  replies=['run.json',true]; await run('saveDocument()');
  assert.equal(aborted,1); assert.equal(requests.at(-1).title,'File not saved');
  assert.match(requests.at(-1).message,/Disk full/);
  assert.equal(run('savingDocument'),false);
  console.log('OK: filename validation, save cancellation, duplicate downloads, explicit replacement, file-picker cancellation, completed writes and write failures.');
})().catch(error=>{console.error(error);process.exitCode=1;});
