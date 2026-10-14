'use strict';

// Wake the free-hosted backend while visitors read the home page. Keep this
// request alive if they immediately continue into a plotting workspace.
void (async function warmBackend() {
  let backend = 'https://root-plotting-tool.onrender.com';
  try {
    backend = localStorage.getItem('rootfit.backendUrl')?.trim() || backend;
  } catch (_) { /* Storage may be unavailable in private browsing. */ }
  try {
    await fetch(backend.replace(/\/+$/, '') + '/health', {
      cache: 'no-store',
      keepalive: true,
      signal: AbortSignal.timeout(90000),
    });
  } catch (_) { /* Waking up is best-effort; the home page stays usable. */ }
})();

const about = document.getElementById('root-dialog');
for (const trigger of document.querySelectorAll('#what-root, [data-root-intro]')) {
  trigger.addEventListener('click', () => about.showModal());
}
for (const dialog of [about]) {
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const r = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
  });
}
if (location.hash === '#choose') location.replace('modern.html');   // old links to the interface chooser
