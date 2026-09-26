// On-device copy of the last daily price series, so the 成績 screen can draw immediately from
// the previous fetch and refresh behind it instead of starting blank every time the app opens.
//
// It lives in its own IndexedDB database on purpose: the main database syncs every change to
// the PC / cloud, and ~1.5MB of re-downloadable market data has no business being uploaded.
const DB_NAME = 'asset-tracker-cache';
const STORE = 'kv';
const KEY = 'dailySeries';

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Resolves null when nothing is saved or storage is unavailable (private mode etc.) — the
// screen then simply waits for the network as it used to.
export async function loadDailyCache() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

export async function saveDailyCache(value) {
  try {
    const db = await openDB();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, KEY);
  } catch (e) {
    // not essential — the next visit just fetches again
  }
}
