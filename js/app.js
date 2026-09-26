import { DB } from './db.js';
import { initSync, pullFromServer, isDirty } from './sync.js';
import { isCloudMode } from './api.js';
import { labelTableCells, isBareTokyoCode, latestSnapshotPerBroker } from './util.js';
import { buildDefaultBrokers } from './defaultBrokers.js';
import { renderDashboard } from './views/dashboard.js';
import { renderPerformance } from './views/performance.js';
import { renderImport } from './views/import.js';
import { renderManual } from './views/manual.js';
import { renderBrokers } from './views/brokers.js';
import { renderHistory } from './views/history.js';
import { renderRecords } from './views/records.js';
import { updateRecords } from './records.js';
import { renderDividends } from './views/dividends.js';
import { renderPrices, refreshAllPrices } from './views/prices.js';
import { syncTickersToServer, registerFundTickers } from './prices.js';
import { renderBackup } from './views/backup.js';

// Shown in the sidebar so "did the update apply?" has a one-glance answer. Keep in step with
// CACHE_NAME in sw.js.
const APP_VERSION = '27';

const state = { brokers: [], snapshots: [], dividends: [], tickers: [], livePrices: {}, fxRates: {}, dividendInfo: {}, dailySeries: null };
let currentView = 'dashboard';

async function loadState() {
  let brokers = await DB.getAllBrokers();

  // Seed the sample accounts ONCE. Re-seeding on every load would resurrect accounts the user
  // deleted, and would also re-create the original "SBI証券" after they rename it to something
  // like "SBI証券（お父さん）" — the rename makes the default name look "missing" again.
  let seededCount = 0;
  if (!(await DB.getMeta('defaultsSeeded'))) {
    const existingNames = new Set(brokers.map((b) => b.name));
    const toSeed = brokers.length === 0
      ? buildDefaultBrokers()
      : buildDefaultBrokers().filter((b) => !existingNames.has(b.name));
    for (const b of toSeed) await DB.saveBroker(b);
    await DB.setMeta('defaultsSeeded', true);
    seededCount = toSeed.length;
  }

  // brokers saved before dividend tracking existed won't have a dividendMapping yet
  const missingDividendMapping = brokers.filter((b) => !b.dividendMapping);
  for (const b of missingDividendMapping) {
    await DB.saveBroker({ ...b, dividendMapping: { name: null, date: null, amount: null, currency: null } });
  }

  if (seededCount || missingDividendMapping.length) brokers = await DB.getAllBrokers();

  state.brokers = brokers;
  state.snapshots = await DB.getAllSnapshots();
  state.dividends = await DB.getAllDividends();
  // Tickers registered before alphanumeric Tokyo codes were recognised were stored bare
  // ("285A" instead of "285A.T"). Yahoo never finds those, so the holding sat frozen at its
  // imported value — repair them once.
  let tickers = await DB.getAllTickers();
  const bare = tickers.filter((t) => isBareTokyoCode(t.code));
  if (bare.length) {
    for (const t of bare) await DB.saveTicker({ ...t, code: String(t.code).trim().toUpperCase() + '.T' });
    tickers = await DB.getAllTickers();
    syncTickersToServer(tickers).catch(() => {});
  }
  state.tickers = tickers;
}

function renderCurrentView() {
  const container = document.getElementById('view-' + currentView);
  const renderers = {
    dashboard: () => renderDashboard(container, state),
    performance: () => renderPerformance(container, state, refresh),
    import: () => renderImport(container, state, refresh),
    manual: () => renderManual(container, state, refresh),
    brokers: () => renderBrokers(container, state, refresh),
    history: () => renderHistory(container, state, refresh),
    records: () => renderRecords(container, state, refresh),
    dividends: () => renderDividends(container, state, refresh),
    prices: () => renderPrices(container, state, refresh),
    backup: () => renderBackup(container, state, refresh),
  };
  renderers[currentView]();
}

async function refresh() {
  await loadState();
  renderCurrentView();
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  document.querySelectorAll('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  renderCurrentView();
}

const sidebar = document.querySelector('.sidebar');
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => { switchView(btn.dataset.view); sidebar.classList.remove('open'); });
});

// --- phone layout helpers ---
// Hamburger menu: on narrow screens the nav is hidden behind a button instead of scrolling.
const navToggle = document.getElementById('nav-toggle');
if (navToggle) navToggle.addEventListener('click', () => sidebar.classList.toggle('open'));

// Any data table that appears in the content area gets per-cell labels so the phone stylesheet
// can lay it out as stacked cards. Raw CSV previews (class raw-grid) are left as real grids.
const labelNewTables = () => {
  document.querySelectorAll('.content table:not(.raw-grid):not([data-labeled="1"])').forEach(labelTableCells);
};
// (runs synchronously — requestAnimationFrame can be paused for background tabs)
new MutationObserver(labelNewTables).observe(document.querySelector('.content'), { childList: true, subtree: true });

// --- PWA install + offline support ---
if ('serviceWorker' in navigator) {
  // The offline cache used to serve the previous version for one extra load, so a fix could
  // look like it hadn't applied. Reload once as soon as the updated worker takes over.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.error('SW registration failed', e));
  });
}

let deferredInstallPrompt = null;
const installBtn = document.getElementById('install-btn');
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

// When the app comes back to the foreground (e.g. the phone after the PC made changes), pick
// up the newer server copy — unless this device has its own unsent edits.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || isDirty()) return;
  const before = localStorage.getItem('assetTrackerSyncedAt');
  const result = await pullFromServer();
  if (result === 'pulled' && localStorage.getItem('assetTrackerSyncedAt') !== before) await refresh();
});

(async function init() {
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `バージョン ${APP_VERSION}`;
  initSync();
  const sync = await pullFromServer();
  await loadState();
  renderCurrentView();
  const statusEl = document.getElementById('sync-status');
  if (statusEl) {
    if (sync === 'offline') statusEl.textContent = 'サーバー未接続（この端末のデータのみ表示）';
    else if (sync === 'unauthorized') statusEl.textContent = '⚠ クラウドのパスワードが一致しません';
    else statusEl.textContent = isCloudMode() ? 'クラウド同期: 正常' : 'PCサーバーと同期: 正常';
  }
  const storageNote = document.getElementById('storage-note');
  if (storageNote) {
    storageNote.textContent = isCloudMode()
      ? 'データはあなたのGoogleドライブに保存され、どの端末からも同じデータを見られます。'
      : 'データはこのPCの asset-tracker/data に保存され、同じWi-Fiのスマホからも見られます。';
  }
  // fetch current prices for any registered tickers as soon as the app opens
  if (state.tickers.length) {
    refreshAllPrices(state, () => { renderCurrentView(); }).catch((e) => console.error('Initial price refresh failed', e));
  }
  // 投資信託 imported before fund prices were supported have no code yet — match them by name
  // once, then price them like everything else
  const heldItems = latestSnapshotPerBroker(state.snapshots).flatMap((s) => s.items);
  registerFundTickers(heldItems).then(async (added) => {
    if (!added) return;
    state.tickers = await DB.getAllTickers();
    state.dailySeries = null;  // 成績 must refetch now that the funds have series
    await refreshAllPrices(state, () => { renderCurrentView(); });
  }).catch((e) => console.error('Fund matching failed', e))
    // then write the daily holdings record for every trading day since the last one (after the
    // fund matching, so newly matched funds are priced in it)
    .finally(() => updateRecords(state).catch((e) => console.error('Daily records failed', e)));
})();
