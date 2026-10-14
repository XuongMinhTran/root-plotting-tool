/* Fit progress for the plotting workspace. */
(function (root) {
  'use strict';

  const WAKEUP_MESSAGE = 'The backend has not responded yet and may still be starting up. This tool is hosted on a free server that sleeps when idle. Please allow another 60 seconds for it to boot up. Your fit will continue automatically.';

  function createProgress(view, timers = {
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: id => clearTimeout(id),
  }) {
    let active = null;
    return {
      start(label = 'Fitting', options = {}) {
        active?.finish();
        const run = {
          received() {
            if (active !== run) return;
            timers.clearTimeout(run.timer);
            view.update('Drawing plot', '');
          },
          finish() {
            timers.clearTimeout(run.timer);
            if (active !== run) return;
            active = null;
            view.hide();
          },
        };
        active = run;
        view.show(label, options.message || '');
        run.timer = timers.setTimeout(() => {
          if (active === run) view.update('Waiting for the server', WAKEUP_MESSAGE);
        }, options.wakeupAfter || 20000);
        return run;
      },
      finish() { active?.finish(); },
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createProgress };
  if (!root.document) return;

  let dialog;
  function update(title, message) {
    dialog.querySelector('h2').textContent = title;
    const text = dialog.querySelector('.fit-progress-message');
    text.textContent = message;
    text.hidden = !message;
  }
  root.FitProgress = createProgress({
    show(label, message) {
      if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.className = 'fit-progress';
        dialog.setAttribute('aria-labelledby', 'fit-progress-title');
        dialog.innerHTML = `
          <div class="fit-progress-dots" aria-hidden="true"><span></span><span></span><span></span></div>
          <div role="status" aria-live="polite" aria-atomic="true">
            <h2 id="fit-progress-title"></h2>
            <p class="fit-progress-message" hidden></p>
          </div>
          <button type="button" class="fit-progress-hide">Continue in background</button>`;
        document.body.appendChild(dialog);
        dialog.querySelector('button').addEventListener('click', () => dialog.close());
      }
      update(label, message || '');
      if (!dialog.open) dialog.showModal();
    },
    update,
    hide() { if (dialog?.open) dialog.close(); },
  });
})(typeof window === 'object' ? window : globalThis);
