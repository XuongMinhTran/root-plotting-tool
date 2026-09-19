/* Modern-only adapter. The shared application continues to submit ROOT text. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const math=$('fit-equation'), mode=$('equation-mode'), raw=$('formula');
  if (!math || !window.RootEquation) return;
  const engine=window.RootEquation;
  let state=null, updating=false;
  const list=value=>value.split(',').map(v=>v.trim());
  const copy=value=>JSON.parse(JSON.stringify(value));
  const canEdit=!!window.MathfieldElement;
  if(canEdit) {
    MathfieldElement.soundsDirectory=null;
    math.mathVirtualKeyboardPolicy='manual';
    math.smartFence=true;
    math.inlineShortcuts={...math.inlineShortcuts, tau:'\\tau',sigma:'\\sigma',mu:'\\mu',alpha:'\\alpha',beta:'\\beta',lambda:'\\lambda',theta:'\\theta',pi:'\\pi', exp:'\\exp',ln:'\\ln'};
  }
  function paint() {
    const visual=state?.mode === 'equation' && canEdit;
    $('mode-equation').checked=visual;
    $('mode-root').checked=!visual;
    $('equation-visual').hidden=!visual;
    $('equation-root').hidden=visual;
    $('equation-translation').hidden=!visual;
    $('root-syntax-links').hidden=visual;
    $('equation-root-preview').textContent=state?.formula || 'No valid expression';
    $('equation-error').textContent=state?.error || '';
    $('equation-error').hidden=!state?.error;
    math.setAttribute('aria-invalid',state?.error?'true':'false');
    $('equation-parameter-heading').textContent=visual?'Symbol / index':'Index';
    $('equation-name-heading').textContent=visual?'Report name':'Name';
  }
  function setMath(value) { if(canEdit) math.setValue(value,{silenceNotifications:true}); }
  function rootState(formula, preferVisual=true) {
    if (!formula.trim() && preferVisual && canEdit) return {latex:'',parameters:[],formula:'',mode:'equation',error:'Enter a fit equation before fitting.',cache:{}};
    try {
      const imported=engine.fromRoot(formula,list($('param-names').value));
      return {...imported,formula,mode:preferVisual&&canEdit?'equation':'root',error:'',cache:{}};
    } catch (_) { return {latex:'',parameters:[],formula,mode:'root',error:'',cache:{}}; }
  }
  function load(settings) {
    const saved=settings?.equation;
    state=saved && saved.formula===raw.value && typeof saved.latex==='string' && Array.isArray(saved.parameters)
      ? copy(saved) : rootState(raw.value);
    state.cache=state.cache && typeof state.cache==='object'?state.cache:{};
    if (!canEdit) { state.mode='root'; state.error='The equation editor could not load. You can still enter a ROOT expression below.'; }
    if(state.mode==='equation') {
      // Revalidate restored drafts; a saved document cannot bypass translation.
      try { engine.compile(state.latex,state.parameters); state.error=''; }
      catch(e) { state.error=e.message; raw.value=''; state.formula=''; }
    }
    setMath(state.latex); paint();
  }
  function sync() {
    if(updating) return;
    if(!state || raw.value!==state.formula) load(null);
    paint();
    if(state.mode==='equation') {
      const rows=$('param-table').querySelectorAll('tbody tr');
      rows.forEach((row,i)=> { row.firstElementChild.textContent=engine.symbolLabel(state.parameters[i] || '')+` [${i}]`; });
      if (state.error) $('param-table-note').textContent='Complete the equation to update its parameters.';
    }
  }
  function changed() {
    syncDatasetFit(); renderParamTable(); autosave();
    document.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function edit() {
    if(updating || !state || state.mode!=='equation') return;
    const names=list($('param-names').value), guesses=list($('initial-guesses').value);
    state.parameters.forEach((symbol,i)=> { state.cache[symbol]={name:names[i] || symbol,guess:guesses[i]??''}; });
    state.latex=math.value;
    try {
      const result=engine.compile(state.latex,state.parameters);
      state.parameters=result.parameters;
      state.formula=result.formula;
      state.error='';
      $('param-names').value=state.parameters.map(symbol=>(Object.hasOwn(state.cache,symbol) ? state.cache[symbol].name : symbol)).join(', ');
      $('initial-guesses').value=state.parameters.map(symbol=>(Object.hasOwn(state.cache,symbol) ? state.cache[symbol].guess : '')).join(', ');
      raw.value=result.formula;
    } catch(e) {
      state.error=e.message;
      state.formula=''; raw.value=''; // Never fit the previous valid expression under an invalid draft.
    }
    updating=true;
    try { changed(); } finally { updating=false; }
    sync();
  }
  math.addEventListener('input',edit);
  // Also commit changes made by the math field on blur or completion.
  math.addEventListener('change',()=> {
    if(state?.mode==='equation' && math.value!==state.latex) edit();
  });
  // The equation has its own Enter behavior; fitting is an explicit action here.
  math.addEventListener('keydown',event=> { if(event.key==='Enter') event.stopPropagation(); });
  raw.addEventListener('input',()=> { state=rootState(raw.value,false); setMath(state.latex); paint(); });
  mode.addEventListener('keydown',event=> {
    if (event.target.name !== 'equation-mode' || event.altKey || event.ctrlKey || event.metaKey) return;
    const arrows=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];
    if (!arrows.includes(event.key) && !['Home','End','Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next=event.key==='Home' ? $('mode-equation') : event.key==='End' ? $('mode-root')
      : event.key==='Enter' ? event.target : $(event.target.value==='root' ? 'mode-equation' : 'mode-root');
    next.focus();
    next.click();
  });
  mode.addEventListener('change',async(event)=> {
    if (event.target.name !== 'equation-mode') return;
    if(event.target.value==='root') {
      // Flush the displayed equation before revealing its ROOT representation.
      if(state?.mode==='equation' && math.value!==state.latex) edit();
      if(state?.error && state.latex) {
        const confirmed=await askDialog({title:'Use ROOT expression',message:'The current equation is incomplete. Switching input modes will discard this equation draft.',accept:'Switch mode'});
        if(!confirmed) { paint(); $('mode-equation').focus(); return; }
      }
      state={...state,mode:'root',error:''}; paint(); changed(); return;
    }
    try {
      if(!canEdit) throw new Error('The equation editor could not load. Reload the page to try again.');
      if (state?.latex && state.formula===raw.value && !state.error) {
        state.mode='equation';
      } else if (!raw.value.trim()) {
        state=rootState('',true);
      } else {
        const imported=engine.fromRoot(raw.value,list($('param-names').value));
        state={...imported,formula:raw.value,mode:'equation',error:'',cache:{}};
      }
      setMath(state.latex); paint(); changed();
    } catch(e) {
      paint();
      $('mode-root').focus();
      $('equation-error').textContent='This ROOT expression cannot be represented by the equation editor. Continue in ROOT expression mode; the formula has been preserved.';
      $('equation-error').hidden=false;
    }
  });
  window.RootEquationEditor={load,sync,
    snapshot() { return state ? copy(state) : undefined; },
    parameterCount() { return state?.mode==='equation' ? state.parameters.length : null; },
    fromRoot() { state=rootState(raw.value); setMath(state.latex); paint(); },
    validate() { if(state?.mode==='equation' && state.error) { math.focus(); throw new Error('Fit equation: '+state.error); } }
  };
})();
