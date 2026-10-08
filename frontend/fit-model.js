/* Lightweight preview and presentation helpers. Never modifies saved fit results. */
(function(scope) {
  'use strict';
  const formatGuess = value => {
    const text=String(value ?? '').trim(), number=Number(text);
    return text && Number.isFinite(number) ? String(Number(number.toPrecision(4))) : text;
  };
  function bounds(values) {
    let low=Infinity, high=-Infinity;
    for(const value of values) if(Number.isFinite(value)) { low=Math.min(low,value); high=Math.max(high,value); }
    return low<=high ? [low,high] : null;
  }
  function adjustGuess(value, step, action) {
    if(!Number.isFinite(value)) throw new Error('Enter a finite starting value.');
    if(['plus','minus'].includes(action) && (!Number.isFinite(step) || step<=0)) throw new Error('Step must be a positive, finite number.');
    const next=action==='plus'?value+step:action==='minus'?value-step:action==='sign'?-value:NaN;
    if(!Number.isFinite(next)) throw new Error('That adjustment is outside the supported number range.');
    if(['plus','minus'].includes(action) && next===value) throw new Error('Step is too small at this magnitude. Increase Step.');
    return next;
  }
  function scaleStep(step, action) {
    if(!Number.isFinite(step) || step<=0) throw new Error('Step must be a positive, finite number.');
    const next=action==='times10'?step*10:action==='divide10'?step/10:NaN;
    if(!Number.isFinite(next) || next<=0) throw new Error('That step is outside the supported number range.');
    return next;
  }
  function defaultAdjustment(value, mode='linear') {
    const magnitude=Math.abs(value)||1;
    const step=Math.pow(10,Math.floor(Math.log10(magnitude))-2)||Number.MIN_VALUE;
    const radius=Math.min(magnitude*2,Number.MAX_VALUE/4);
    return {step,mode,low:mode==='log'?Math.max(Number.MIN_VALUE,magnitude/1000):Math.max(-Number.MAX_VALUE,value-radius),
      high:mode==='log'?Math.min(Number.MAX_VALUE,magnitude*1000):Math.min(Number.MAX_VALUE,value+radius)};
  }
  function sliderValue(position, low, high, mode='linear', sign=1) {
    if(!Number.isFinite(position) || !Number.isFinite(low) || !Number.isFinite(high) || low>=high || (mode==='log' && low<=0)) throw new Error('Enter an increasing, finite range. Logarithmic magnitude limits must be positive.');
    const t=Math.max(0,Math.min(1,position));
    // Preserve representable endpoints even at the floating-point limits.
    const magnitude=t===0?low:t===1?high:mode==='log'?10**((1-t)*Math.log10(low)+t*Math.log10(high)):(1-t)*low+t*high;
    return mode==='log'?(sign<0?-1:1)*magnitude:magnitude;
  }
  function sliderPosition(value, low, high, mode='linear') {
    if(mode==='log' && value===0) return .5;
    const position=mode==='log'?(Math.log10(Math.abs(value))-Math.log10(low))/(Math.log10(high)-Math.log10(low)):
      (value/2-low/2)/(high/2-low/2);
    return Math.max(0,Math.min(1,position));
  }
  function valuesKey(text) {
    const values=String(text ?? '').split(',').map(token=> {
      const value=token.trim(); return value && Number.isFinite(Number(value))?Number(value):value;
    });
    while(values.at(-1)==='') values.pop();
    return JSON.stringify(values);
  }
  function startingStatus(guesses, count, provenance, signature) {
    const values=String(guesses).split(',').map(value=>value.trim());
    const ready=count>0 && Array.from({length:count},(_,i)=>values[i]).every(value=>value && Number.isFinite(Number(value)));
    if(!ready) return {ready:false, text:values.some(Boolean)?'Starting values are incomplete. Estimate or edit them before fitting.':'Using model defaults. Estimate or edit values to see the starting curve.'};
    const recorded=provenance?.values===valuesKey(guesses);
    const source=recorded?provenance.source:null;
    const text=source==='automatic'?'Estimated from your data.':source==='adjusted'?'Adjusted manually.':source==='edited'?'Edited.':'Starting values set.';
    const changed=recorded && provenance.signature!==signature;
    return {ready:true, text:(changed?text+' The data or model changed; review the curve or re-estimate.':'✓ '+text+' Review the curve, then run Fit.')};
  }
  function previewModel(engine, formula, names, guesses, xMin, xMax) {
    const imported=engine.fromRoot(formula,names);
    const expression=engine.expression(imported.latex);
    const values={};
    imported.parameters.forEach((symbol,i)=> {
      const value=String(guesses[i] ?? '').trim();
      if(!value || !Number.isFinite(Number(value))) throw new Error('Enter or estimate starting values to see the model curve.');
      values[symbol]=Number(value);
    });
    if(!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin>=xMax) throw new Error('Choose a fit range with its minimum below its maximum.');
    const curve=[];
    for(let i=0;i<=240;i++) {
      const x=xMin+(xMax-xMin)*i/240;
      try { curve.push([x,expression.evaluate({...values,x})]); } catch (_) { curve.push([x,null]); }
    }
    if(curve.every(p=>p[1]===null)) throw new Error('The model is undefined at these starting values. Check widths, denominators and function domains.');
    return curve;
  }
  const helpers={formatGuess,bounds,previewModel,adjustGuess,scaleStep,defaultAdjustment,sliderValue,sliderPosition,valuesKey,startingStatus};
  if(typeof module==='object' && module.exports) module.exports=helpers;
  if(typeof document==='undefined') return;
  const $=id=>document.getElementById(id), raw=$('formula'), table=$('param-table');
  if(!raw || !table) return;
  let timer;
  const adjustments=new Map();
  let controlKey='';
  const panel=$('guess-preview-panel'), controls=$('visual-parameters'), openButton=$('visual-match-open');
  const searches=new Map();
  const currentDataset=()=>typeof datasets==='undefined'?null:datasets[activeIdx];
  const datasetKey=()=>currentDataset()?.id || String(typeof activeIdx==='undefined'?0:activeIdx);
  function signature() {
    const dataset=currentDataset();
    return JSON.stringify({data:scope.WorkspaceStore?.signature(dataset || {}) || dataset,formula:raw.value,range:[$('fit-xmin').value,$('fit-xmax').value]});
  }
  function recordSource(source, curve=null, warnings=[]) {
    const dataset=currentDataset(); if(!dataset) return;
    dataset.startingValues={source,values:valuesKey($('initial-guesses').value),signature:signature(),curve,warnings};
    searches.delete(datasetKey());
    if(typeof autosave==='function') autosave();
  }
  function searchState(state, key=datasetKey()) {
    if(state) searches.set(key,state); else searches.delete(key);
    updateStartingStatus();
  }
  function updateStartingStatus() {
    const count=table.querySelectorAll('[data-pguess]').length, provenance=currentDataset()?.startingValues;
    const state=searches.get(datasetKey()), busy=!!state?.busy;
    const base=startingStatus($('initial-guesses').value,count,provenance,signature());
    const message=state?.busy || state?.failed?state.message:(count?base.text:'Choose a model with adjustable parameters to set starting values.');
    if($('starting-values-status').textContent!==message) $('starting-values-status').textContent=message;
    $('starting-values-error').textContent=state?.error || ''; $('starting-values-error').hidden=!state?.error;
    const estimate=$('starting-values-estimate');
    estimate.textContent=provenance?.source==='automatic'?'Re-estimate':'Estimate starting values';
    estimate.classList.toggle('primary',provenance?.source!=='automatic');
    estimate.disabled=busy || !count || !['xy','histogram'].includes($('analysis-type').value) || (typeof fitBusy!=='undefined' && fitBusy);
    $('starting-values-stop').hidden=!busy; $('starting-values-stop').disabled=!!state?.cancelling;
    openButton.classList.toggle('primary',!!state?.failed);
    const warnings=provenance?.values===valuesKey($('initial-guesses').value) && Array.isArray(provenance.warnings)?provenance.warnings:[];
    const list=$('starting-values-warnings'); list.replaceChildren();
    warnings.forEach(message=> { const item=document.createElement('li'); item.textContent=String(message); list.append(item); });
    $('starting-values-notes').hidden=!warnings.length;
  }
  function cachedCurve() {
    const estimate=currentDataset()?.startingValues;
    const curve=estimate?.curve;
    return estimate?.signature===signature() && estimate.values===valuesKey($('initial-guesses').value) && Array.isArray(curve?.x) && Array.isArray(curve.y) && curve.x.length===curve.y.length?curve:null;
  }
  function adjustmentError(message='') { $('visual-match-error').textContent=message; $('visual-match-error').hidden=!message; }
  function setGuess(index, value) {
    const input=table.querySelector(`[data-pguess="${index}"]`);
    if(!input) return;
    input.value=String(value); input.dataset.fullGuess=input.value;
    input.dispatchEvent(new CustomEvent('input',{bubbles:true,detail:{startingValuesSource:'adjusted'}}));
  }
  function syncControls() {
    if(!controls) return;
    const inputs=[...table.querySelectorAll('[data-pguess]')];
    let available=$('analysis-type').value==='xy' && inputs.length>0;
    try { scope.RootEquation.expression(scope.RootEquation.fromRoot(raw.value,$('param-names').value.split(',')).latex); }
    catch(_) { available=false; }
    openButton.disabled=!available;
    $('visual-match-help').textContent=available?"Curve doesn't follow the data? Adjust it before running Fit.":($('analysis-type').value!=='xy'?'Estimate or edit values for this analysis. Interactive curve adjustment is available for XY models.':'Estimate or edit values for this model. Interactive adjustment requires a model supported by the live preview.');
    $('visual-adjust-mode').disabled=!available;
    const dataset=typeof datasets==='undefined'?null:datasets[activeIdx];
    const key=`${dataset?.id || (typeof activeIdx==='undefined'?0:activeIdx)}|${raw.value}`;
    if(key!==controlKey || controls.children.length!==(available?inputs.length:0)) {
      $('visual-adjustments').hidden=true; openButton.setAttribute('aria-expanded','false'); openButton.textContent='Adjust on the plot'; panel.classList.remove('is-adjusting');
      controls.replaceChildren(); controlKey=key; adjustmentError();
      if(available) inputs.forEach((input,i)=> {
        const card=document.createElement('div'); card.className='visual-parameter'; card.dataset.index=i;
        card.innerHTML=`<label class="visual-parameter-name" for="visual-value-${i}"></label>
          <div class="visual-value-row"><button type="button" data-adjust="minus">−</button><input id="visual-value-${i}" class="mono" type="text" inputmode="decimal" data-visual-value="${i}"><button type="button" data-adjust="plus">+</button></div>
          <div class="visual-step-row"><label for="visual-step-${i}">Step <input id="visual-step-${i}" class="mono" type="text" inputmode="decimal" data-visual-step="${i}"></label><div class="visual-magnitude-buttons"><button type="button" data-adjust="divide10">÷10</button><button type="button" data-adjust="times10">×10</button><button type="button" data-adjust="sign">±</button></div></div>
          <div class="visual-slider-controls" hidden><input type="range" min="0" max="1000" step="1" data-visual-slider="${i}">
          <details><summary>Range and scale</summary><div class="visual-range-row"><label for="visual-scale-${i}">Scale<select id="visual-scale-${i}" data-visual-scale="${i}"><option value="linear">Linear</option><option value="log">Log magnitude</option></select></label><label for="visual-min-${i}"><span data-range-label="min">Minimum</span><input id="visual-min-${i}" class="mono" type="text" inputmode="decimal" data-visual-bound="low"></label><label for="visual-max-${i}"><span data-range-label="max">Maximum</span><input id="visual-max-${i}" class="mono" type="text" inputmode="decimal" data-visual-bound="high"></label></div></details></div>`;
        controls.append(card);
      });
    }
    const names=$('param-names').value.split(',').map(s=>s.trim());
    inputs.forEach((input,i)=> {
      const card=controls.children[i]; if(!card) return;
      const label=names[i] || `Parameter ${i}`, valueText=input.dataset.fullGuess ?? input.value;
      const value=Number(valueText), finite=!!valueText.trim() && Number.isFinite(value);
      const stateKey=key+'|'+i;
      if(!adjustments.has(stateKey)) adjustments.set(stateKey,defaultAdjustment(finite?value:1));
      const state=adjustments.get(stateKey);
      const inRange=state.mode==='log'?Math.abs(value)>=state.low&&Math.abs(value)<=state.high:value>=state.low&&value<=state.high;
      if(finite && !inRange && !(state.mode==='log' && value===0)) Object.assign(state,defaultAdjustment(value,state.mode),{step:state.step});
      card.querySelector('.visual-parameter-name').textContent=label+` [${i}]`;
      for(const [selector,text] of [['[data-visual-value]',valueText],['[data-visual-step]',state.step],['[data-visual-bound="low"]',state.low],['[data-visual-bound="high"]',state.high]]) {
        const field=card.querySelector(selector); if(document.activeElement!==field) field.value=String(text);
      }
      const descriptions={minus:`Decrease ${label} by Step`,plus:`Increase ${label} by Step`,times10:`Multiply ${label} Step by 10`,divide10:`Divide ${label} Step by 10`,sign:`Flip the sign of ${label}`};
      card.querySelectorAll('[data-adjust]').forEach(button=> { button.disabled=['times10','divide10'].includes(button.dataset.adjust)?false:!finite; button.title=descriptions[button.dataset.adjust]; button.setAttribute('aria-label',button.title); });
      card.querySelector('.visual-slider-controls').hidden=$('visual-adjust-mode').value!=='slider';
      const slider=card.querySelector('[data-visual-slider]'); slider.disabled=!finite || state.mode==='log'&&value===0;
      slider.title=state.mode==='log'&&value===0?'Enter a nonzero guess for a logarithmic slider, or choose Linear.':'';
      slider.setAttribute('aria-label',`${label} starting value`); slider.setAttribute('aria-valuetext',valueText || 'Enter a starting value');
      if(document.activeElement!==slider) slider.value=String(1000*sliderPosition(finite?value:1,state.low,state.high,state.mode));
      const scale=card.querySelector('[data-visual-scale]');
      if(document.activeElement!==scale) scale.value=state.mode;
      card.querySelector('[data-range-label="min"]').textContent=state.mode==='log'?'Smallest magnitude':'Minimum';
      card.querySelector('[data-range-label="max"]').textContent=state.mode==='log'?'Largest magnitude':'Maximum';
    });
  }
  function fillBlankGuesses() {
    if(openButton.disabled) return;
    const guesses=$('initial-guesses').value.split(',');
    const defaults=String(scope.ModelLibrary?.guideFor(raw.value)?.guesses || '').split(',');
    const count=table.querySelectorAll('[data-pguess]').length;
    let changed=false;
    for(let i=0;i<count;i++) if(!String(guesses[i]??'').trim()) { guesses[i]=defaults[i]?.trim() && Number.isFinite(Number(defaults[i]))?defaults[i]:'1'; changed=true; }
    if(changed) { $('initial-guesses').value=guesses.join(', '); $('initial-guesses').dispatchEvent(new CustomEvent('input',{bubbles:true,detail:{startingValuesSource:'adjusted'}})); }
  }
  openButton?.addEventListener('click',()=> {
    fillBlankGuesses();
    const pane=$('visual-adjustments'); pane.hidden=!pane.hidden;
    openButton.setAttribute('aria-expanded',String(!pane.hidden));
    openButton.textContent=pane.hidden?'Adjust on the plot':'Hide adjustment controls';
    panel.classList.toggle('is-adjusting',!pane.hidden); syncControls(); renderPreview();
  });
  controls?.addEventListener('click',event=> {
    const button=event.target.closest('[data-adjust]'); if(!button) return;
    const card=button.closest('.visual-parameter'), index=Number(card.dataset.index), state=adjustments.get(controlKey+'|'+index);
    try {
      const stepText=card.querySelector('[data-visual-step]').value.trim(), step=stepText?Number(stepText):NaN;
      if(['times10','divide10'].includes(button.dataset.adjust)) {
        state.step=scaleStep(step,button.dataset.adjust);
        card.querySelector('[data-visual-step]').value=String(state.step);
        adjustmentError(); syncControls(); return;
      }
      const valueText=card.querySelector('[data-visual-value]').value.trim();
      const value=adjustGuess(valueText?Number(valueText):NaN,step,button.dataset.adjust);
      adjustmentError(); setGuess(index,value);
    } catch(error) { adjustmentError(error.message); }
  });
  controls?.addEventListener('input',event=> {
    const target=event.target, card=target.closest('.visual-parameter'); if(!card) return;
    const index=Number(card.dataset.index), state=adjustments.get(controlKey+'|'+index);
    if(target.matches('[data-visual-value]')) {
      const text=target.value.trim();
      // Mirror even incomplete text so Fit cannot submit an older hidden value.
      if(text && Number.isFinite(Number(text))) adjustmentError();
      setGuess(index,text);
    } else if(target.matches('[data-visual-step]')) {
      const step=Number(target.value.trim()); if(Number.isFinite(step)&&step>0) state.step=step;
    } else if(target.matches('[data-visual-scale]')) {
      // A select emits input before change; update its state before the global refresh.
      const text=card.querySelector('[data-visual-value]').value.trim(), value=Number(text);
      if(text && Number.isFinite(value)) Object.assign(state,defaultAdjustment(value,target.value),{step:state.step});
    } else if(target.matches('[data-visual-slider]')) {
      try {
        const valueText=card.querySelector('[data-visual-value]').value.trim();
        if(!valueText || !Number.isFinite(Number(valueText))) throw new Error('Enter a finite starting value.');
        adjustmentError(); setGuess(index,sliderValue(Number(target.value)/1000,state.low,state.high,state.mode,Number(valueText)));
      }
      catch(error) { adjustmentError(error.message); }
    }
  });
  controls?.addEventListener('change',event=> {
    const target=event.target, card=target.closest('.visual-parameter'); if(!card) return;
    const index=Number(card.dataset.index), state=adjustments.get(controlKey+'|'+index), valueText=card.querySelector('[data-visual-value]').value.trim(), value=Number(valueText);
    try {
      if(target.matches('[data-visual-scale], [data-visual-bound]') && (!valueText || !Number.isFinite(value))) throw new Error('Enter a finite starting value before changing the slider range.');
      if(target.matches('[data-visual-scale]')) Object.assign(state,defaultAdjustment(value,target.value),{step:state.step});
      else if(target.matches('[data-visual-bound]')) {
        const lower=card.querySelector('[data-visual-bound="low"]').value.trim(), upper=card.querySelector('[data-visual-bound="high"]').value.trim();
        if(!lower || !upper) throw new Error('Enter both adjustment range limits.');
        sliderValue(.5,Number(lower),Number(upper),state.mode);
        const low=Number(lower), high=Number(upper), current=state.mode==='log'?Math.abs(value):value;
        if(current<low || current>high) throw new Error('Include the current guess in the adjustment range, or change the guess first.');
        state.low=low; state.high=high;
      } else if(target.matches('[data-visual-value]') && (!target.value.trim() || !Number.isFinite(Number(target.value)))) throw new Error('Enter a finite starting value.');
      else if(target.matches('[data-visual-step]') && (!target.value.trim() || !Number.isFinite(Number(target.value)) || Number(target.value)<=0)) throw new Error('Step must be a positive, finite number.');
      adjustmentError(); syncControls();
    } catch(error) { adjustmentError(error.message); }
  });
  function growFormula() {
    raw.style.height='auto'; raw.style.height=Math.max(82,raw.scrollHeight+2)+'px';
  }
  function renderPreview() {
    const host=$('guess-preview'), note=$('guess-preview-note');
    host.replaceChildren();
    const type=$('analysis-type').value;
    const column=type==='histogram' ? ($('hist-source').value==='samples' ? 'hist-samples' : 'hist-edges') : 'col-x';
    const parsed=typeof parseColumn==='function' ? parseColumn($(column)?.value || '') : {values:[],bad:[]};
    const omitted=typeof datasets==='undefined'?[]:(datasets[activeIdx]?.exclusions || []);
    const y=type==='xy'?parseColumn($('col-y').value):{values:[],bad:[]};
    const excluded=new Set(omitted.filter(o=>parsed.values[o.index]===o.x&&y.values[o.index]===o.y).map(o=>o.index));
    let dataBounds=bounds(parsed.values.filter((_,i)=>!excluded.has(i)));
    if(type==='histogram') {
      const edges=parseColumn($('hist-edges').value).values;
      const lo=$('hist-min').value.trim(), hi=$('hist-max').value.trim();
      dataBounds=edges.length?bounds(edges):lo&&hi&&Number.isFinite(Number(lo))&&Number.isFinite(Number(hi))?[Number(lo),Number(hi)]:dataBounds;
    }
    const minText=$('fit-xmin').value.trim(), maxText=$('fit-xmax').value.trim();
    const low=minText?Number(minText):dataBounds?.[0], high=maxText?Number(maxText):dataBounds?.[1];
    $('fit-range-summary').textContent='Fit range: '+(!minText && !maxText?'full data':'selected range')+
      (Number.isFinite(low)&&Number.isFinite(high)?` (${formatGuess(low)} – ${formatGuess(high)})`:'');
    const choice=scope.ModelLibrary?.guideFor(raw.value);
    $('model-choice-name').textContent=choice?.name || (raw.value.trim()?'Custom model':'No model — plot data only');
    if(type!=='xy') {
      const cached=cachedCurve();
      const points=(Array.isArray(cached?.data_x)?cached.data_x:[]).map((x,i)=>[x,cached.data_y?.[i]]).filter(p=>p.every(Number.isFinite));
      const curve=(cached?.x || []).map((x,i)=>[x,cached.y?.[i]]).filter(p=>p.every(Number.isFinite));
      const limits=bounds(points.map(p=>p[0]).concat(curve.map(p=>p[0])));
      if(points.length && curve.length && limits[0]<limits[1]) note.textContent=drawStartingCurve(host,points,curve,...limits);
      else note.textContent='Estimate starting values to preview this model. Live curve adjustment is available for supported XY models.';
      return;
    }
    if(parsed.bad.length || y.bad.length || parsed.values.length!==y.values.length || parsed.values.length<2) { note.textContent='Add matching X and Y measurements to preview your model.'; return; }
    if(!Number.isFinite(low) || !Number.isFinite(high) || low>=high) { note.textContent='Choose an increasing X range to preview the starting curve.'; return; }
    const points=parsed.values.map((x,i)=>[x,y.values[i]]).filter((p,i)=>!excluded.has(i) && p[0]>=low&&p[0]<=high);
    if(points.length<2) { note.textContent='Include at least two measurements in the fit range to preview the model.'; return; }
    let curve=[], warning='';
    try { curve=previewModel(scope.RootEquation,raw.value,$('param-names').value.split(',').map(s=>s.trim()),$('initial-guesses').value.split(','),low,high); }
    catch(error) {
      const cached=cachedCurve();
      if(Array.isArray(cached?.x) && cached.x.length===cached.y?.length) curve=cached.x.map((x,i)=>[x,cached.y[i]]).filter(p=>p.every(Number.isFinite));
      if(!curve.length) warning=/starting values|undefined|fit range/.test(error.message)?error.message:'Estimate or edit starting values to see this ROOT model curve. Live adjustment is unavailable for this function.';
    }
    note.textContent=warning || drawStartingCurve(host,points,curve,low,high);
    if(warning) drawStartingCurve(host,points,curve,low,high);
  }
  function drawStartingCurve(host,points,curve,low,high) {
    // Keep the measurement scale steady while the user moves the curve.
    const yBounds=bounds(points.map(p=>p[1]));
    const span=yBounds[1]-yBounds[0] || Math.max(1,Math.abs(yBounds[0])*.1), ymin=yBounds[0]-span*.08, ymax=yBounds[1]+span*.08;
    if(!Number.isFinite(ymax-ymin) || !Number.isFinite(ymin) || !Number.isFinite(ymax)) return 'These measurements are outside the supported preview range.';
    const sx=x=>52+(x-low)/(high-low)*544, sy=y=>Math.max(-1e6,Math.min(1e6,210-(y-ymin)/(ymax-ymin)*184));
    let path='', restart=true;
    for(const [x,y] of curve) { if(y===null) { restart=true; continue; } path+=(restart?'M':'L')+sx(x).toFixed(2)+','+sy(y).toFixed(2)+' '; restart=false; }
    const step=Math.max(1,Math.ceil(points.length/1500));
    const dots=points.filter((_,i)=>i%step===0).map(([x,y])=>`<circle cx="${sx(x).toFixed(2)}" cy="${sy(y).toFixed(2)}" r="2.5" fill="#354759"/>`).join('');
    host.innerHTML=`<svg viewBox="0 0 624 244" role="img" aria-label="Starting curve over your included measurements; not a fit result"><defs><clipPath id="guess-preview-clip"><rect x="52" y="22" width="544" height="188"/></clipPath></defs><path d="M52 22 V210 H596" stroke="#becbd7" fill="none"/><g clip-path="url(#guess-preview-clip)"><path d="${path}" stroke="#346295" stroke-width="2" stroke-dasharray="6 4" fill="none"/>${dots}</g><g font-size="12" fill="#657487"><text x="52" y="234">${formatGuess(low)}</text><text x="596" y="234" text-anchor="end">${formatGuess(high)}</text><text x="324" y="234" text-anchor="middle">x</text><text x="46" y="30" text-anchor="end">${formatGuess(ymax)}</text><text x="46" y="210" text-anchor="end">${formatGuess(ymin)}</text></g></svg>`;
    return curve.some(p=>p[1]===null)?'Some parts of this model are undefined at these starting values. Check the curve before fitting.':curve.some(p=>p[1]<ymin||p[1]>ymax)?'Part of the curve is outside the data scale. Adjust the values to bring it toward your measurements.':'';
  }
  function refresh() {
    growFormula();
    syncControls();
    updateStartingStatus();
    for(const input of table.querySelectorAll('[data-pguess]')) {
      if(document.activeElement!==input) input.value=formatGuess(input.dataset.fullGuess ?? input.value);
    }
    if(!timer) timer=setTimeout(()=> { timer=null; renderPreview(); },80);
  }
  table.addEventListener('focusin',event=> {
    const input=event.target;
    if(input.matches('[data-pguess]')) { input.value=input.dataset.fullGuess ?? input.value; input.select(); }
  });
  table.addEventListener('focusout',event=> {
    if(event.target.matches('[data-pguess]')) event.target.value=formatGuess(event.target.dataset.fullGuess ?? event.target.value);
  });
  document.addEventListener('input',event=> {
    if(event.target.matches?.('[data-pguess], #initial-guesses')) recordSource(event.detail?.startingValuesSource || 'edited',event.detail?.curve,event.detail?.warnings);
    refresh();
  });
  document.addEventListener('change',refresh);
  document.addEventListener('rootfit:reset',refresh); document.addEventListener('rootfit:draw',refresh);
  // Switching plots restores data programmatically; observe the selector as well.
  document.addEventListener('click',refresh);
  new ResizeObserver(growFormula).observe(raw.parentElement);
  scope.FitModelUX={...helpers,refresh,growFormula,recordSource,searchState};
  refresh();
})(globalThis);
