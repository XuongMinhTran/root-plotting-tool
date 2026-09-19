const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
let attached=null, resized=null;
const plot={style:{},replaceChildren(node){attached=node;},querySelector(){return attached;}};
const jsroot={version:'test',cleanup(){},parse:x=>JSON.parse(x),registerForResize(){},
 async draw(surface){assert.equal(attached,surface,'Attach container before JSROOT measures it');assert.equal(surface.style.width,'100%');assert.equal(surface.style.height,'100%');return {};},
 resize(surface){resized=surface;}};
const context=vm.createContext({console,window:{addEventListener(){},JSROOT:jsroot},
 document:{getElementById:id=>id==='plot'?plot:{},dispatchEvent(){},querySelectorAll(){return[];},createElement:()=>({style:{},dataset:{}})},CustomEvent:class{}});
vm.runInContext(fs.readFileSync('frontend/app.js','utf8').replace(/\ninit\(\);\s*$/,''),context);
vm.runInContext('loadLayout=()=>({}); loadJSROOT=async()=>window.JSROOT; setPngEnabled=()=>{}; setStatus=()=>{};',context);
(async()=>{
 await vm.runInContext('drawPlot({canvas_json:{},plot_height:600},true)',context);
 assert.equal(plot.style.height,'600px');
 vm.runInContext('replotToSize()',context);
 assert.equal(resized,attached,'Resize the actual JSROOT container when showing Results');
 console.log('OK: plot attaches before measurement and resizes its drawing container.');
})().catch(e=>{console.error(e);process.exitCode=1;});
