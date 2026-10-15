/* Lesson 1: Your first fit. The user rebuilds the double-slit example from a
 * downloaded file, picks starting values their own way, fits, and reads the
 * result. Checks read the app's state; "Show me" does the step for them. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const MODEL = {
    formula: '[1]+[0]/2*([2]*(x-[4])==0?1:pow(sin([2]*(x-[4]))/([2]*(x-[4])),2))*(1+([6]+[7]*(x-[4]))*cos(2*[3]*(x-[5])))',
    params: 'count_scale, background, envelope_scale, fringe_frequency, envelope_center, fringe_origin, visibility, visibility_slope',
    guesses: '1, 0, 1, 5, 0, 0, 0.5, 0',
    symbols: 'N0, N_bg, k_a, k_d, x_1, x_0, V, V_1',
  };
  const GOOD = '58000, 700, 1.0, 4.13, 5.5, 5.75, 0.55, 0.03';
  // "Close enough" for each starting value: wide bands, since the fit does the rest.
  const between = (lo, hi) => v => Number.isFinite(v) && v >= lo && v <= hi;
  const TARGETS = [between(30000, 90000), between(0, 3000), between(0.5, 2), between(3.6, 4.6), between(5.2, 5.8), between(5.4, 6.1), between(0.2, 0.9), between(-0.3, 0.3)];
  const norm = f => String(f || '').replace(/\s+/g, '');
  const numbers = text => (String(text || '').match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) || []).map(Number);
  const active = () => (typeof datasets !== 'undefined' && datasets[activeIdx]) || {};
  const result = () => active().result?.response || null;
  const onFitStep = () => $('step-function') && !$('step-function').hidden;
  const modelChosen = () => norm($('formula')?.value) === norm(MODEL.formula);
  const guessesChanged = () => { const g = numbers($('initial-guesses')?.value); return g.length === 8 && g.join() !== numbers(MODEL.guesses).join(); };
  const fire = (el, type = 'input') => el && el.dispatchEvent(new Event(type, {bubbles: true}));
  const fmt = v => Number(v).toPrecision(4).replace(/\.?0+$/, '');
  let csvText = null;
  async function csv() {
    if (csvText) return csvText;
    const r = await fetch('tutorials/double-slit.csv'); csvText = await r.text(); return csvText;
  }

  window.TutorialLessons = window.TutorialLessons || {};
  window.TutorialLessons['first-fit'] = {
    title: 'Your first fit',
    start(ctx) {
      // Work in a fresh dataset so nothing of the user's is touched.
      if (typeof syncActiveFromColumns !== 'function') return;
      syncActiveFromColumns();
      const d = datasets[activeIdx];
      const untouched = !d.analysis_type && !/[0-9]/.test(d.x + d.y);
      if (ctx.state.done.length && d.name === 'Double slit (tutorial)') return;   // resuming
      if (!untouched) { datasets.push(newDataset('Double slit (tutorial)', '')); activeIdx = datasets.length - 1; }
      else d.name = 'Double slit (tutorial)';
      showActiveInColumns();
    },
    steps: [
      {
        id: 'welcome', title: 'Get the data',
        text: `<p>In about five minutes you will take real measurements from a double-slit experiment, fit the physics to them and read off how visible the fringes are.</p>
          <p>Download the data. It has three columns: detector position <code>x</code>, counts <code>y</code>, and the uncertainty on each count.</p>`,
        actions: `<a class="tut-download" href="tutorials/double-slit.xlsx" download data-next>Excel file (.xlsx)</a><a class="tut-download" href="tutorials/double-slit.csv" download data-next>CSV file</a>`,
        done: ctx => ctx.flags['welcome:next'],
      },
      {
        id: 'type', title: 'Say what kind of data it is', target: '#setup-type',
        text: `<p>Choose <strong>One variable f(x)</strong>: one measured quantity (counts) that depends on one other (position).</p>`,
        done: () => active().analysis_type === 'xy',
        demo: () => { const s = $('setup-type'); s.value = 'xy'; fire(s, 'change'); },
      },
      {
        id: 'paste', title: 'Paste the data', target: '#setup-grid',
        text: `<p>Open the file, select the three columns <em>including the header row</em>, and copy. Click the first cell of the table and paste.</p>
          <p class="tut-aside">The header tells the table which column is which, so the order in your file doesn't matter. Prefer not to open the file? <strong>Import CSV</strong> below the table does the same.</p>`,
        done: () => { const x = numbers($('col-x')?.value), y = numbers($('col-y')?.value), ey = numbers($('col-ey')?.value); return x.length >= 80 && y.length >= 80 && ey.length >= 80; },
        demo: async () => {
          const rows = (await csv()).trim().split('\n').slice(1).map(l => l.split(','));
          const put = (id, i) => { const el = $(id); el.value = rows.map(r => r[i]).join('\n'); fire(el); };
          put('col-x', 0); put('col-y', 1); put('col-ey', 2);
          syncActiveFromColumns(); const d = active(); d.uncertainty_modes = {...(d.uncertainty_modes || {}), ey: 'per-point'}; showActiveInColumns();
        },
      },
      {
        id: 'xunc', title: 'Add the position uncertainty',
        target: () => document.querySelector('#setup-grid [data-mode]') && [...document.querySelectorAll('#setup-grid .unc-mode')].find(s => /^x/i.test(s.getAttribute('aria-label') || '')),
        text: `<p>Every position was read to ±0.01, so the file left that column out. Set <strong>X uncertainty</strong> to <strong>Constant</strong> and enter <code>0.01</code>.</p>
          <p class="tut-aside">Per point, Constant or None is a choice you make for every column. None means "treat as exact", which is rarely true of a measurement.</p>`,
        done: () => { const d = active(); const v = numbers($('col-ex')?.value); return v.length === 1 && Math.abs(v[0] - 0.01) < 1e-9 && (d.uncertainty_modes?.ex || 'constant') !== 'none'; },
        demo: () => { const el = $('col-ex'); el.value = '0.01'; fire(el); syncActiveFromColumns(); const d = active(); d.uncertainty_modes = {...(d.uncertainty_modes || {}), ex: 'constant'}; showActiveInColumns(); },
      },
      {
        id: 'continue', title: 'Go to the fit model', target: '#modern-next',
        text: `<p>The preview on the right should show a bright central fringe with smaller ones either side. Press <strong>Continue to fit model</strong>.</p>`,
        done: onFitStep,
        demo: () => $('modern-next').click(),
      },
      {
        id: 'model', title: 'Choose the physics', target: '#model-library-btn',
        text: `<p>Press <strong>Choose a model…</strong>, open <strong>Waves &amp; optics</strong> and use <strong>Double-slit (linear fringe visibility)</strong>, not the plain double-slit above it.</p>
          <p class="tut-aside">The equation is a single-slit envelope (the sinc²) times the two-slit fringes (the cos). V is the fringe visibility, the thing this experiment measures.</p>`,
        done: modelChosen,
        demo: () => applyFunctionExample([MODEL.formula, MODEL.params, MODEL.guesses, MODEL.symbols].join('|')),
      },
      {
        id: 'look', title: 'Starting values: your call',
        text: `<p>Look at the preview: the dashed curve is the model with the library's generic starting values, and it doesn't follow the data. A fit only finds the best curve <em>near</em> where it starts, so starting values matter.</p><p>Three honest ways to get them. Pick one:</p>`,
        choices: [
          {id: 'adjust', goto: 'adjust-open', label: 'Adjust on the plot', desc: 'Nudge each value until the curve roughly follows the data. The physicist\'s way.'},
          {id: 'ai', goto: 'ai-open', label: 'Ask an AI', desc: 'Copy a ready-made prompt into ChatGPT or Claude and paste its numbers back.'},
          {id: 'brute', goto: 'brute', label: 'Brute force', desc: 'Let the computer search for about 20 seconds. Fast, but you learn less.'},
        ],
      },
      // --- branch: adjust on the plot ---
      {
        id: 'adjust-open', branch: 'adjust', title: 'Open the controls', target: '#visual-match-open',
        text: `<p>Press <strong>Adjust on the plot</strong>.</p>`,
        done: () => $('visual-match-open')?.getAttribute('aria-expanded') === 'true',
        demo: () => $('visual-match-open').click(),
      },
      {
        id: 'adjust-do', branch: 'adjust', title: 'Make the curve follow the data', live: true,
        text: () => {
          const g = numbers($('initial-guesses')?.value), row = (i, label, hint) => `<li class="${TARGETS[i](g[i]) ? 'tut-ok' : ''}">${label} <span>${hint}</span></li>`;
          return `<p>For each value, type a number in its box (or use − / + with a bigger Step). Watch the dashed curve move. Read these off the plot:</p>
          <ul class="tut-check">${row(0, 'count_scale ≈ 58000', 'about 1.3 × the tallest peak')}${row(1, 'background ≈ 700', 'the floor between fringes')}${row(2, 'envelope_scale ≈ 1', 'leave it')}${row(3, 'fringe_frequency ≈ 4.1', 'π ÷ fringe spacing of 0.75')}${row(4, 'envelope_center ≈ 5.5', 'middle of the whole pattern')}${row(5, 'fringe_origin ≈ 5.75', 'position of the brightest fringe')}${row(6, 'visibility ≈ 0.5', 'how deep the dips are, 0 to 1')}${row(7, 'visibility_slope ≈ 0', 'leave it')}</ul>
          <p>Roughly right is enough: the fit does the rest. Each line ticks when its value is close enough.</p>`;
        },
        done: () => { const g = numbers($('initial-guesses')?.value); return g.length === 8 && TARGETS.every((ok, i) => ok(g[i])); },
        next: 'fit',
        demo: () => { const el = $('initial-guesses'); el.value = GOOD; fire(el); fire(el, 'change'); },
      },
      // --- branch: ask an AI ---
      {
        id: 'ai-open', branch: 'ai', title: 'Ask uncle ChatGPT', target: '#ask-ai-starting-values',
        text: `<p>Press <strong>Ask AI for starting values</strong>. The dialog builds a prompt that contains your data and the equation.</p>`,
        enter: ctx => { ctx.flags.aiSeen = false; },
        done: ctx => { if ($('ai-starting-dialog')?.open) ctx.flags.aiSeen = true; return ctx.flags.aiSeen; },
        demo: () => $('ask-ai-starting-values')?.click(),
      },
      {
        id: 'ai-use', branch: 'ai', title: 'Bring the numbers back', target: '#initial-guesses', noScroll: true,
        text: `<p>Copy the prompt, paste it into ChatGPT or Claude, and ask for the eight starting values. Back here, press <strong>Go to manual entry</strong> and paste the numbers into <strong>Initial guesses</strong>, comma-separated, in the order shown.</p>
          <p class="tut-aside">Nothing is sent anywhere by this tool. And an AI can be wrong: check the dashed curve before you fit.</p>`,
        done: guessesChanged, next: 'fit',
        demo: () => { const el = $('initial-guesses'); el.value = GOOD; fire(el); fire(el, 'change'); },
      },
      // --- branch: brute force ---
      {
        id: 'brute', branch: 'brute', title: 'Let the computer search', target: '#starting-values-estimate',
        text: `<p>Press <strong>Brute force fit</strong>. For about 20 seconds it tries many combinations, keeps the best and then runs the real fit from there.</p>
          <p class="tut-aside">Handy when you're stuck, but it can land on a wrong answer that looks plausible. Always check the curve.</p>`,
        done: () => !!result(), next: 'read',
        demo: () => $('starting-values-estimate')?.click(),
      },
      // --- main line resumes ---
      {
        id: 'fit', title: 'Fit', target: '#btn-fit',
        text: `<p>Press <strong>Fit</strong>. ROOT adjusts all eight values to minimise χ², the weighted distance between the curve and your points.</p>`,
        done: () => !!result(),
        demo: () => $('btn-fit').click(),
      },
      {
        id: 'read', title: 'Read the result',
        text: () => {
          const r = result();
          if (!r) return '<p>Run the fit to see the result here.</p>';
          if (r.converged === false) return `<p>The fit did not converge: from these starting values ROOT could not find a minimum. That happens, and it is why the starting values mattered.</p><p><button type="button" class="link-btn" data-goto="look">Try another way to get starting values</button></p>`;
          const p = Object.fromEntries((r.params || []).map(q => [q.name, q]));
          const V = p.visibility, chi = r.chi2_ndf != null ? Number(r.chi2_ndf) : (r.chi2 && r.ndf ? r.chi2 / r.ndf : null);
          return `<p>Converged. ${V ? `Fringe visibility <strong>V = ${fmt(V.value)} ± ${fmt(V.error)}</strong>.` : ''} The uncertainty comes from how sharply χ² rises when V moves away from its best value.</p>
            <p>χ²/NDF = <strong>${chi != null ? fmt(chi) : '?'}</strong>. Is that a good fit?</p>
            <button type="button" class="tut-reveal" data-reveal>Show answer</button><div class="tut-answer" hidden><p>Near 1 means the scatter of the points about the curve matches their error bars. ${chi != null && chi > 1.2 ? `${fmt(chi)} is a little high: the points scatter more than their error bars say, so either the uncertainties are slightly underestimated or the model is missing a small effect. Still a perfectly usable fit.` : 'This is a good fit.'}</p></div>
            <p><button type="button" class="button-like" data-next>Got it</button></p>`;
        },
        done: ctx => ctx.flags['read:next'],
      },
      {
        id: 'done', title: 'That\'s a fit', final: true,
        text: `<p>You rebuilt the double-slit example from raw data: data in, physics chosen, starting values, fit, result.</p>
          <p>From here: press <strong>Save</strong> to keep the analysis as a file, or try one of the other ways to get starting values. <button type="button" class="link-btn" data-goto="look">Back to the choice</button> · <button type="button" class="link-btn" data-restart>Start over</button></p>
          <p><a href="tutorials.html">More tutorials</a></p>`,
      },
    ],
  };
})();
