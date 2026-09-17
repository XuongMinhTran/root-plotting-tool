/* Native ROOT workspace. Deliberately independent of app.js and its form model. */
'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const KEY='rootcli.document.v1', LIVE='rootcli.live.v2', API='/api/root';
  const localFileMessage='Commands cannot run in a downloaded copy of this page. Open the CLI on the website to run them. You can use Save session to keep your input and open it there.';
  let commands=[], canvases=[], painter=null, jsroot=null, loadingRoot=null;
  let live=null, running=false, requestAbort=null, historyIndex=0, historyDraft='', drawVersion=0;
  try {
    // Remove credentials left by the earlier client-managed connection flow.
    sessionStorage.removeItem('rootcli.connection.v1');
    sessionStorage.removeItem('rootcli.live.v1');
    live=JSON.parse(sessionStorage.getItem(LIVE));
  } catch (_) {}
  const examples={
    calculation:'double energy = 2.5;\nstd::cout << "sqrt(energy) = " << std::sqrt(energy) << std::endl;',
    histogram:'auto c = new TCanvas("histogram_canvas", "Histogram", 900, 600);\nauto h = new TH1D("measurements", "Gaussian sample;Value;Entries", 60, -4, 4);\nh->FillRandom("gaus", 5000);\nh->Draw();',
    surface:'auto c3 = new TCanvas("surface_canvas", "3D surface", 900, 650);\nauto surface = new TF2("surface", "sin(x)*cos(y)", -3, 3, -3, 3);\nsurface->SetTitle("3D surface;X;Y;Z");\nsurface->Draw("surf1");'
  };
  function message(text='',error=false) { $('cli-message').textContent=text; $('cli-message').hidden=!text; $('cli-message').className='message '+(error?'error':'info'); }
  function storeLive() { try { if(live) sessionStorage.setItem(LIVE,JSON.stringify(live)); else sessionStorage.removeItem(LIVE); } catch (_) {} updateStatus(); }
  function updateStatus() {
    $('cli-status').textContent=running?'Running ROOT command…':live?'ROOT session connected':'No active ROOT session';
    $('cli-run').disabled=running; $('new-session').disabled=running;
    $('command-input').readOnly=running;
    for(const button of document.querySelectorAll('[data-example]')) button.disabled=running;
    $('stop-session').disabled=!live; $('stop-session').textContent=running?'Stop session':'End session';
    for(const id of ['upload-file','refresh-files']) $(id).disabled=!live || running;
    $('load-session').disabled=running;
  }
  function persist() {
    try { localStorage.setItem(KEY,JSON.stringify(NativeSession.write($('command-input').value,commands,canvases))); $('draft-status').textContent='Saved in this browser'; }
    catch (_) { $('draft-status').textContent='Browser storage is full. Use Save session to keep this work.'; }
  }
  function download(blob,name) { const a=document.createElement('a'), url=URL.createObjectURL(blob); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000); }
  function textFile(text,name,type='text/plain') { download(new Blob([text],{type}),name); }
  function append(entry) {
    $('command-log').querySelector('.log-intro')?.remove();
    const row=document.createElement('div'); row.className='command-entry'+(entry.ok?'':' error');
    const code=document.createElement('pre'); code.textContent='root> '+entry.code;
    const output=document.createElement('pre'); output.className='command-response'; output.textContent=entry.output || 'Command completed.';
    row.append(code,output); $('command-log').append(row); $('command-log').scrollTop=$('command-log').scrollHeight;
  }
  async function api(path,{method='GET',json,body,signal}={}) {
    if(location.protocol==='file:') throw new Error(localFileMessage);
    let response;
    try { response=await fetch(API+path,{method,credentials:'same-origin',headers:{'X-ROOT-CLI':'1',...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(json):body,signal}); }
    catch(e) { if(e.name==='AbortError') throw e; throw new Error('The connection was interrupted. Your input is still here. Please try again shortly.'); }
    if(!(response.headers.get('Content-Type') || '').includes('application/json')) {
      throw new Error('The command interface is temporarily unavailable. Your input is still here. Please try again shortly.');
    }
    if(!response.ok) {
      const data=await response.json().catch(()=>({}));
      if(data.session_lost) { live=null; storeLive(); }
      throw new Error(data.error || `The backend could not finish the request (HTTP ${response.status}).`);
    }
    return response;
  }
  async function createSession() {
    const data=await (await api('/sessions',{method:'POST'})).json();
    live={id:data.session}; storeLive();
    message(`ROOT ${data.root_version} session started. Variables remain available until you end this session.`);
  }
  async function endSession(ask=true) {
    if(!live) return true;
    if(ask && !confirm('End this ROOT session? Live variables and temporary files will be removed. Your command history and canvas snapshots will remain.')) return false;
    const ending=live.id;
    await api('/sessions/'+ending,{method:'DELETE'});
    requestAbort?.abort(); live=null; running=false; storeLive();
    $('session-files').textContent='The session has ended. Start a new session to work with files.';
    message('ROOT session ended. Your command history and canvas snapshots are still available.');
    return true;
  }
  async function run() {
    const code=$('command-input').value.trim();
    if(running || !code) { if(!code) message('Enter a ROOT/C++ command first. Usage and examples has a few starting points.'); return; }
    running=true; updateStatus(); message();
    let entry=null, submittedSession=null;
    try {
      if(!live) await createSession();
      submittedSession=live.id;
      requestAbort=new AbortController();
      const data=await (await api('/sessions/'+submittedSession+'/execute',{method:'POST',json:{code},signal:requestAbort.signal})).json();
      if(live?.id !== submittedSession) return;
      const output=[!data.ok?'ROOT could not complete this input. Some earlier statements may have run; details follow.':'',data.output,...(data.notes || [])].filter(Boolean).join('\n');
      entry={code,output,ok:data.ok}; commands.push(entry); append(entry);
      historyIndex=commands.length;
      canvases=data.canvases || []; await showCanvases();
      if(data.ok) { $('command-input').value=''; message(); }
      else message('ROOT reported a problem with this input. The diagnostic output is shown in the console, and the input remains available to edit.',true);
      await refreshFiles();
    } catch(e) {
      if(e.name!=='AbortError') {
        message(e.message,true);
        if(submittedSession && !entry) { entry={code,output:e.message,ok:false}; commands.push(entry); append(entry); historyIndex=commands.length; }
      }
    } finally { running=false; requestAbort=null; updateStatus(); persist(); $('command-input').focus(); }
  }
  async function loadRoot() {
    if(jsroot) return jsroot;
    if(!loadingRoot) loadingRoot=(async()=>{
      if(!window.JSROOT) {
        for(const url of ['https://root.cern/js/latest/build/jsroot.min.js','https://root.cern/js/latest/build/jsroot.js']) {
          try { await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Script unavailable'));};document.head.append(script);}); } catch(_) {}
          if(window.JSROOT)break;
        }
        if(!window.JSROOT)throw new Error('JSROOT could not load. Your command output and canvas snapshots are retained; check the internet connection and select the canvas again.');
      }
      jsroot=window.JSROOT; jsroot.settings.PreferSavedPoints=true; return jsroot;
    })().catch(e=>{loadingRoot=null;throw e;});
    return loadingRoot;
  }
  async function showCanvases() {
    const selected=$('canvas-select').value;
    $('canvas-select').replaceChildren();
    for(const [i,c] of canvases.entries()) { const option=document.createElement('option');option.value=String(i);option.textContent=c.name+(c.title && c.title!==c.name?' — '+c.title:'');$('canvas-select').append(option); }
    $('canvas-select').disabled=!canvases.length;
    if(!canvases.length) { const option=document.createElement('option');option.textContent='No canvases';$('canvas-select').append(option); }
    else $('canvas-select').value=+selected<canvases.length?selected:'0';
    await draw();
  }
  async function draw() {
    const version=++drawVersion, c=canvases[+$('canvas-select').value]; painter=null;
    $('export-png').disabled=true; $('export-svg').disabled=true;
    if(jsroot) jsroot.cleanup($('cli-plot'));
    $('cli-plot').replaceChildren();
    if(!c) { $('cli-plot').textContent='No canvas to display.'; return; }
    $('canvas-note').textContent='Canvas snapshot from the most recent submitted command or opened session. Selecting a canvas does not execute code.';
    try {
      const root=await loadRoot(); if(version!==drawVersion) return;
      $('canvas-select').disabled=true;
      painter=await root.draw($('cli-plot'),root.parse(JSON.stringify(c.json)),'');
      root.registerForResize(painter);
      $('export-png').disabled=false; $('export-svg').disabled=false;
    } catch(e) { $('cli-plot').textContent='This canvas could not be displayed by JSROOT. '+e.message; }
    finally { $('canvas-select').disabled=!canvases.length; }
  }
  async function exportImage(kind) {
    if(!painter) return;
    const canvas=painter.getCanvPainter?.() || painter;
    const result=await canvas.produceImage(true,kind);
    if(!result) throw new Error('JSROOT could not export this canvas. The session still contains its snapshot.');
    const name=(canvases[+$('canvas-select').value]?.name || 'canvas').replace(/[^a-zA-Z0-9_-]/g,'_');
    if(kind==='svg') textFile(result,name+'.svg','image/svg+xml');
    else { const a=document.createElement('a');a.href=result.startsWith('data:')?result:'data:image/png;base64,'+result;a.download=name+'.png';a.click(); }
  }
  function filesList(files) {
    $('session-files').replaceChildren();
    if(!files.length) { $('session-files').textContent='No files in the session working directory.'; return; }
    for(const file of files) {
      const row=document.createElement('div'); row.className='session-file';
      const name=document.createElement('span'); name.textContent=`${file.name} (${Math.ceil(file.size/1024)} KB)`;
      const button=document.createElement('button');button.type='button';button.textContent='Download';button.setAttribute('aria-label','Download '+file.name);
      button.addEventListener('click',()=>safe(async()=>{if(!live) throw new Error('This session has ended.');const r=await api('/sessions/'+live.id+'/files/'+encodeURIComponent(file.name));download(await r.blob(),file.name);}));
      row.append(name,button);$('session-files').append(row);
    }
  }
  async function refreshFiles() { if(live) filesList((await (await api('/sessions/'+live.id+'/files')).json()).files); }
  async function safe(fn) { try { await fn(); } catch(e) { message(e.message,true); } }
  $('cli-run').addEventListener('click',run);
  $('command-input').addEventListener('input',persist);
  $('command-input').addEventListener('keydown',event=>{
    if((event.ctrlKey || event.metaKey) && event.key==='Enter') {event.preventDefault();run();return;}
    if(!['ArrowUp','ArrowDown'].includes(event.key) || (!event.altKey && $('command-input').value.includes('\n'))) return;
    if(!commands.length) return;
    if(historyIndex===commands.length) historyDraft=$('command-input').value;
    event.preventDefault();historyIndex=Math.max(0,Math.min(commands.length,historyIndex+(event.key==='ArrowUp'?-1:1)));
    $('command-input').value=historyIndex===commands.length?historyDraft:commands[historyIndex].code;persist();
  });
  $('cli-help').addEventListener('click',()=>{$('command-reference').open=!$('command-reference').open;});
  for(const button of document.querySelectorAll('[data-example]')) button.addEventListener('click',()=>{if($('command-input').value.trim() && !confirm('Replace the current input with this example?')) return;$('command-input').value=examples[button.dataset.example];persist();$('command-input').focus();});
  $('cli-clear-log').addEventListener('click',()=>{$('command-log').replaceChildren();message('Output cleared. Commands remain in session history.');});
  $('canvas-select').addEventListener('change',draw);
  $('export-png').addEventListener('click',()=>safe(()=>exportImage('png')));
  $('export-svg').addEventListener('click',()=>safe(()=>exportImage('svg')));
  $('save-code').addEventListener('click',()=>textFile($('command-input').value,'root-input.C'));
  $('save-session').addEventListener('click',()=>textFile(JSON.stringify(NativeSession.write($('command-input').value,commands,canvases),null,2),'root-session.json','application/json'));
  $('load-session').addEventListener('click',()=>$('open-file').click());
  $('open-file').addEventListener('change',()=>safe(async()=>{
    const file=$('open-file').files[0];$('open-file').value='';if(!file)return;
    if(file.size>32*1024*1024)throw new Error('Open a text or session file smaller than 32 MB.');
    const text=await file.text();
    if(file.name.toLowerCase().endsWith('.json')) {
      let parsed;try{parsed=JSON.parse(text);}catch(_){throw new Error('This session file is not readable JSON.');}
      const data=NativeSession.read(parsed);
      if((commands.length || $('command-input').value) && !confirm('Replace the command history, input and snapshots with this saved session? Save the current session first if you want to keep it.'))return;
      if(live && !await endSession()) return;
      commands=data.commands;canvases=data.canvases;$('command-input').value=data.input;$('command-log').replaceChildren();commands.forEach(append);historyIndex=commands.length;await showCanvases();
      message('Session opened as text and canvas snapshots. No commands were executed. Start a new ROOT session and run the declarations you need.');
    } else {
      if($('command-input').value.trim() && !confirm('Replace the current input with this file?'))return;
      $('command-input').value=text;message('File opened in the input editor. It has not been executed.');
    }
    persist();
  }));
  $('new-session').addEventListener('click',()=>safe(async()=>{if(live && !await endSession())return;running=true;updateStatus();try{await createSession();await refreshFiles();}finally{running=false;updateStatus();}}));
  $('stop-session').addEventListener('click',()=>safe(()=>endSession()));
  $('upload-file').addEventListener('click',()=>$('upload-input').click());
  $('refresh-files').addEventListener('click',()=>safe(refreshFiles));
  $('upload-input').addEventListener('change',()=>safe(async()=>{const file=$('upload-input').files[0];$('upload-input').value='';if(!file || !live)return;const body=new FormData();body.append('file',file);filesList((await (await api('/sessions/'+live.id+'/files',{method:'POST',body})).json()).files);message(`Uploaded ${file.name}. It is available in the session working directory; it has not been executed.`);}));
  try { const saved=localStorage.getItem(KEY);if(saved){const data=NativeSession.read(JSON.parse(saved));commands=data.commands;canvases=data.canvases;$('command-input').value=data.input;commands.forEach(append);historyIndex=commands.length;showCanvases();} } catch(_){message('The saved CLI session could not be restored. You can open a downloaded session file.');}
  updateStatus();
  if(location.protocol==='file:') message(localFileMessage,true);
  else if(live)safe(refreshFiles);
})();
