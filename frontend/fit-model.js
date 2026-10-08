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
  function previewModel(engine, formula, names, guesses, xMin, xMax) {
    const imported=engine.fromRoot(formula,names);
    const expression=engine.expression(imported.latex);
    const values={};
    imported.parameters.forEach((symbol,i)=> {
      const value=String(guesses[i] ?? '').trim();
      if(!value || !Number.isFinite(Number(value))) throw new Error('Enter starting values, or use Automatic guess, to see the model curve.');
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
  const helpers={formatGuess,bounds,previewModel};
  if(typeof module==='object' && module.exports) module.exports=helpers;
  if(typeof document==='undefined') return;
  const $=id=>document.getElementById(id), raw=$('formula'), table=$('param-table');
  if(!raw || !table) return;
  let timer, activeParameter=null;
  function growFormula() {
    raw.style.height='auto'; raw.style.height=Math.max(82,raw.scrollHeight+2)+'px';
    const mirror=$('formula-highlights');
    mirror.replaceChildren();
    const text=raw.value, pattern=/\[(\d+)\]/g;
    let end=0;
    for(const match of text.matchAll(pattern)) {
      mirror.append(document.createTextNode(text.slice(end,match.index)));
      if(Number(match[1])===activeParameter) {
        const mark=document.createElement('mark'); mark.textContent=match[0]; mirror.append(mark);
      } else mirror.append(document.createTextNode(match[0]));
      end=match.index+match[0].length;
    }
    mirror.append(document.createTextNode(text.slice(end)+'\n'));
  }
  function highlight(row) {
    activeParameter=row ? [...table.querySelectorAll('tbody tr')].indexOf(row) : null;
    for(const item of table.querySelectorAll('tbody tr')) item.classList.toggle('is-highlighted',item===row);
    growFormula();
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
    if(type!=='xy') { note.textContent='Live starting-value previews are available for XY models. Your fit and plot options still work here.'; return; }
    if(parsed.bad.length || y.bad.length || parsed.values.length!==y.values.length || parsed.values.length<2) { note.textContent='Add matching X and Y measurements to preview your model.'; return; }
    if(!raw.value.trim()) { note.textContent='Choose a model to preview its starting values.'; return; }
    const points=parsed.values.map((x,i)=>[x,y.values[i]]).filter((p,i)=>!excluded.has(i) && p[0]>=low&&p[0]<=high);
    if(points.length<2) { note.textContent='Include at least two measurements in the fit range to preview the model.'; return; }
    let curve;
    try { curve=previewModel(scope.RootEquation,raw.value,$('param-names').value.split(',').map(s=>s.trim()),$('initial-guesses').value.split(','),low,high); }
    catch(error) {
      note.textContent=/starting values|undefined|fit range/.test(error.message)?error.message:'Live preview is unavailable for this ROOT function. You can still use Fit; Automatic guess is available for supported expressions.';
      return;
    }
    const yBounds=bounds(points.map(p=>p[1]).concat(curve.filter(p=>p[1]!==null).map(p=>p[1])));
    const span=yBounds[1]-yBounds[0] || Math.max(1,Math.abs(yBounds[0])*.1), ymin=yBounds[0]-span*.08, ymax=yBounds[1]+span*.08;
    if(!Number.isFinite(ymax-ymin) || !Number.isFinite(ymin) || !Number.isFinite(ymax)) { note.textContent='These starting values make the curve too large to preview. Try smaller values or Automatic guess.'; return; }
    const sx=x=>52+(x-low)/(high-low)*544, sy=y=>210-(y-ymin)/(ymax-ymin)*184;
    let path='', restart=true;
    for(const [x,y] of curve) { if(y===null) { restart=true; continue; } path+=(restart?'M':'L')+sx(x).toFixed(2)+','+sy(y).toFixed(2)+' '; restart=false; }
    const step=Math.max(1,Math.ceil(points.length/1500));
    const dots=points.filter((_,i)=>i%step===0).map(([x,y])=>`<circle cx="${sx(x).toFixed(2)}" cy="${sy(y).toFixed(2)}" r="2.5" fill="#354759"/>`).join('');
    host.innerHTML=`<svg viewBox="0 0 624 244" role="img" aria-label="Initial guess model curve over your included measurements; not a fit result"><path d="M52 22 V210 H596" stroke="#becbd7" fill="none"/><path d="${path}" stroke="#346295" stroke-width="2" stroke-dasharray="6 4" fill="none"/>${dots}<g font-size="12" fill="#657487"><text x="52" y="234">${formatGuess(low)}</text><text x="596" y="234" text-anchor="end">${formatGuess(high)}</text><text x="324" y="234" text-anchor="middle">x</text><text x="46" y="30" text-anchor="end">${formatGuess(ymax)}</text><text x="46" y="210" text-anchor="end">${formatGuess(ymin)}</text></g></svg>`;
    note.textContent=curve.some(p=>p[1]===null)?'Some parts of this model are undefined at these starting values. Check the curve before fitting.':'';
  }
  function refresh() {
    growFormula();
    for(const input of table.querySelectorAll('[data-pguess]')) {
      if(document.activeElement!==input) input.value=formatGuess(input.dataset.fullGuess ?? input.value);
    }
    clearTimeout(timer); timer=setTimeout(renderPreview,140);
  }
  table.addEventListener('focusin',event=> {
    const input=event.target;
    if(input.matches('[data-pguess]')) { input.value=input.dataset.fullGuess ?? input.value; input.select(); }
    highlight(input.closest('tbody tr'));
  });
  table.addEventListener('focusout',event=> {
    if(event.target.matches('[data-pguess]')) event.target.value=formatGuess(event.target.dataset.fullGuess ?? event.target.value);
    highlight(null);
  });
  table.addEventListener('pointerover',event=>highlight(event.target.closest('tbody tr')));
  table.addEventListener('pointerleave',()=>highlight(document.activeElement.closest?.('tbody tr')));
  document.addEventListener('input',refresh); document.addEventListener('change',refresh);
  document.addEventListener('rootfit:reset',refresh); document.addEventListener('rootfit:draw',refresh);
  // Switching plots restores data programmatically; observe the selector as well.
  document.addEventListener('click',()=> { clearTimeout(timer); timer=setTimeout(renderPreview,140); });
  new ResizeObserver(growFormula).observe(raw.parentElement);
  scope.FitModelUX={...helpers,refresh,growFormula};
  refresh();
})(globalThis);
