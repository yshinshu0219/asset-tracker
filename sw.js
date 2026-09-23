// Service worker: caches the app shell so the installed PWA can open even when the local
// python server isn't running (after the first successful load). Bump CACHE_NAME whenever
// app files change so clients pick up the new version.
const CACHE_NAME = 'asset-tracker-v21';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/csv.js',
  './js/util.js',
  './js/prices.js',
  './js/autoMap.js',
  './js/performance.js',
  './js/sync.js',
  './js/api.js',
  './js/defaultBrokers.js',
  './js/institutionPresets.js',
  './js/views/dashboard.js',
  './js/views/performance.js',
  './js/views/import.js',
  './js/views/manual.js',
  './js/views/brokers.js',
  './js/views/history.js',
  './js/views/dividends.js',
  './js/views/prices.js',
  './js/views/backup.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  'https://cdn.jsdelivr.net/npm/encoding-japanese@2.2.0/encoding.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    // CDN libraries are best-effort: don't fail install if one can't be fetched right now.
    await Promise.all(CDN_ASSETS.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Live price data must always hit the network — never serve a stale cached quote/history.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    // Network-first. The server is on localhost so this costs nothing, and it means an updated
    // file is picked up on the very next load. Cache-first (the previous strategy) kept serving
    // the old build for an extra load — or indefinitely, if the update check never ran — which
    // made every fix look like it hadn't applied. The cache is only a fallback for offline use.
    try {
      const response = await fetch(event.request, { cache: 'no-store' });
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (e) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});
