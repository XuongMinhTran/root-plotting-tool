'use strict';
const chooser = document.getElementById('workspace-dialog');
const about = document.getElementById('root-dialog');
document.getElementById('make-plot').addEventListener('click', () => chooser.showModal());
document.getElementById('what-root').addEventListener('click', () => about.showModal());
for (const dialog of [chooser, about]) {
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const r = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
  });
}
if (location.hash === '#choose') chooser.showModal();
