/* Tutorial runner: a docked panel of hands-on steps inside Make a Plot.
 * Steps advance when the app's state shows the step was done, not when a
 * "Next" button is pressed. Lessons are data (window.TutorialLessons); this
 * file only knows how to run one. Open modern.html?tutorial=<lesson id>. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lessons = window.TutorialLessons || {};
  const id = new URLSearchParams(location.search).get('tutorial');
  const lesson = id && lessons[id];
  if (!lesson) return;

  const KEY = 'rootfit.tutorial.' + id;
  const steps = lesson.steps;
  const byId = Object.fromEntries(steps.map(s => [s.id, s]));
  let state = {step: steps[0].id, branch: null, done: []};
  try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); if (saved && byId[saved.step]) state = {...state, ...saved}; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const ctx = {flags: {}, lesson, state, $};

  // ---- panel ----
  const panel = document.createElement('aside');
  panel.id = 'tutorial-panel';
  panel.setAttribute('aria-label', 'Tutorial');
  panel.innerHTML = `<div class="tut-head"><span class="tut-kicker">Tutorial</span><strong class="tut-title">${esc(lesson.title)}</strong><button type="button" class="tut-collapse" aria-expanded="true" title="Hide or show the steps">hide</button></div>
    <ol class="tut-progress" aria-hidden="true"></ol>
    <div class="tut-body"><div class="tut-count"></div><h2 class="tut-step-title"></h2><div class="tut-text"></div><div class="tut-actions"></div><p class="tut-done-note" hidden>✓ Done</p></div>
    <div class="tut-foot"><button type="button" class="link-btn tut-demo" hidden>Show me</button><button type="button" class="link-btn tut-skip" hidden>Skip this step</button><button type="button" class="link-btn tut-exit">Exit tutorial</button></div>`;
  document.body.appendChild(panel);
  document.body.classList.add('with-tutorial');
  const live = document.createElement('div'); live.className = 'sr-only'; live.setAttribute('aria-live', 'polite'); panel.appendChild(live);

  panel.querySelector('.tut-collapse').addEventListener('click', e => {
    const open = panel.classList.toggle('is-collapsed') === false;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.textContent = open ? 'hide' : 'show';
  });
  panel.querySelector('.tut-exit').addEventListener('click', () => exit());
  panel.querySelector('.tut-skip').addEventListener('click', () => advance(true));
  panel.querySelector('.tut-demo').addEventListener('click', async () => {
    const step = byId[state.step];
    try { await step.demo?.(ctx); } catch (e) { console.warn('tutorial demo', e); }
    tick();
  });
  panel.addEventListener('click', e => {
    const choice = e.target.closest('[data-choice]');
    if (choice) { state.branch = choice.dataset.choice; go(choice.dataset.goto); return; }
    const next = e.target.closest('[data-next]');
    if (next) { ctx.flags[state.step + ':next'] = true; tick(); return; }
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) { const box = reveal.nextElementSibling; if (box) { box.hidden = false; reveal.hidden = true; } return; }
    if (e.target.closest('[data-restart]')) { state.done = []; state.branch = null; ctx.flags = {}; go(steps[0].id); return; }
    const jump = e.target.closest('[data-goto]');
    if (jump) { go(jump.dataset.goto); }
  });

  function exit() {
    byId[state.step]?.leave?.(ctx);
    clearHighlight();
    panel.remove();
    document.body.classList.remove('with-tutorial');
    const url = new URL(location.href); url.searchParams.delete('tutorial'); history.replaceState(null, '', url);
    clearInterval(timer);
  }

  // ---- highlight ----
  let highlighted = null;
  function clearHighlight() { highlighted?.classList.remove('tutorial-target'); highlighted = null; }
  function highlight(step) {
    clearHighlight();
    if (!step.target) return;
    const el = typeof step.target === 'function' ? step.target(ctx) : document.querySelector(step.target);
    if (!el) return;
    el.classList.add('tutorial-target'); highlighted = el;
    if (!step.noScroll) { try { el.scrollIntoView({block: 'center', behavior: 'smooth'}); } catch {} }
  }

  // ---- rendering ----
  function visibleSteps() {
    // The main line plus the chosen branch, in lesson order.
    return steps.filter(s => !s.branch || s.branch === state.branch);
  }
  function render() {
    const step = byId[state.step];
    const list = visibleSteps(), at = list.indexOf(step);
    panel.querySelector('.tut-progress').innerHTML = list.map((s, i) => `<li class="${state.done.includes(s.id) ? 'is-done' : ''}${s.id === step.id ? ' is-current' : ''}" title="${esc(s.title)}"></li>`).join('');
    panel.querySelector('.tut-count').textContent = `Step ${at + 1} of ${list.length}`;
    panel.querySelector('.tut-step-title').textContent = step.title;
    panel.querySelector('.tut-text').innerHTML = typeof step.text === 'function' ? step.text(ctx) : step.text;
    const actions = panel.querySelector('.tut-actions');
    actions.innerHTML = step.choices ? step.choices.map(c => `<button type="button" class="tut-choice" data-choice="${esc(c.id)}" data-goto="${esc(c.goto)}"><strong>${esc(c.label)}</strong><span>${esc(c.desc)}</span></button>`).join('')
      : (step.actions || '');
    panel.querySelector('.tut-demo').hidden = !step.demo;
    panel.querySelector('.tut-skip').hidden = !!step.choices || !!step.final;
    panel.querySelector('.tut-done-note').hidden = true;
    panel.classList.toggle('is-final', !!step.final);
    highlight(step);
    live.textContent = `Step ${at + 1}: ${step.title}`;
    step.enter?.(ctx);
  }
  function go(stepId) {
    if (!byId[stepId]) return;
    byId[state.step]?.leave?.(ctx);
    state.step = stepId; save(); render();
  }
  let advancing = false;
  function advance(skipped) {
    const step = byId[state.step];
    if (!state.done.includes(step.id)) state.done.push(step.id);
    const next = typeof step.next === 'function' ? step.next(ctx) : step.next || visibleSteps()[visibleSteps().indexOf(step) + 1]?.id;
    if (!next) { save(); return; }
    if (skipped) { go(next); return; }
    advancing = true;
    panel.querySelector('.tut-done-note').hidden = false;
    setTimeout(() => { advancing = false; go(next); }, 650);
  }

  // ---- checking ----
  function tick() {
    if (advancing) return;
    const step = byId[state.step];
    if (!step || step.choices || step.final) return;
    step.tick?.(ctx);
    if (step.live) {   // steps whose text reports progress re-render as the state changes
      const html = typeof step.text === 'function' ? step.text(ctx) : step.text, box = panel.querySelector('.tut-text');
      if (box.innerHTML !== html) box.innerHTML = html;
    }
    let ok = false;
    try { ok = !!step.done?.(ctx); } catch {}
    if (ok) advance(false);
  }
  const timer = setInterval(tick, 400);
  for (const type of ['input', 'change', 'click', 'keyup']) document.addEventListener(type, () => setTimeout(tick, 50), true);

  lesson.start?.(ctx);
  render();
  window.Tutorial = {go, state, exit};
})();
