import { label, probe, type ConnectionState } from './connection';
import './style.css';

const app = document.getElementById('app')!;
app.innerHTML = `
  <header><img src="/pwa/brand/yeastay-logo-white.svg" alt="YeaStay" /></header>
  <div class="status checking" role="status" aria-live="polite" id="status"></div>
  <main>
    <h1 id="title">Choose a mode</h1>
    <p>This device app is a placeholder. Waiter POS and housekeeping screens are built in later modules.</p>
    <div class="modes">
      <button class="mode" data-mode="waiter"><strong>Waiter</strong><span>Orders, tables and tabs (POS-01 to POS-19)</span></button>
      <button class="mode" data-mode="housekeeping"><strong>Housekeeping</strong><span>Room board and cleaning tasks (HK-01 to HK-04)</span></button>
    </div>
    <p class="note" id="mode-note"></p>
  </main>`;

const statusEl = document.getElementById('status')!;
function render(state: ConnectionState) {
  statusEl.className = `status ${state}`;
  statusEl.textContent = label(state);
}

async function refresh() {
  render(await probe());
}
render('checking');
void refresh();
setInterval(refresh, 15_000);
window.addEventListener('online', refresh);
window.addEventListener('offline', () => render('offline'));

const note = document.getElementById('mode-note')!;
const saved = localStorage.getItem('yeastay.mode');
if (saved) note.textContent = `This device was last used for ${saved}.`;
document.querySelectorAll<HTMLButtonElement>('.mode').forEach((btn) =>
  btn.addEventListener('click', () => {
    localStorage.setItem('yeastay.mode', btn.dataset.mode!);
    note.textContent = `${btn.dataset.mode === 'waiter' ? 'Waiter' : 'Housekeeping'} mode is coming in a later release.`;
  }),
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/pwa/sw.js', { scope: '/pwa/' }));
}
