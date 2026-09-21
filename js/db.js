// IndexedDB wrapper for the asset tracker app.
const DB_NAME = 'asset-tracker';
const DB_VERSION = 4;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('brokers')) {
        db.createObjectStore('brokers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        const store = db.createObjectStore('snapshots', { keyPath: 'id' });
        store.createIndex('brokerId', 'brokerId', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('dividends')) {
        const store = db.createObjectStore('dividends', { keyPath: 'id' });
        store.createIndex('brokerId', 'brokerId', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('tickers')) {
        db.createObjectStore('tickers', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDB() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function tx(storeName, mode) {
  return getDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const DB = {
  async getAllBrokers() {
    const store = await tx('brokers', 'readonly');
    return reqToPromise(store.getAll());
  },
  async saveBroker(broker) {
    const store = await tx('brokers', 'readwrite');
    return reqToPromise(store.put(broker));
  },
  async deleteBroker(id) {
    const store = await tx('brokers', 'readwrite');
    return reqToPromise(store.delete(id));
  },
  async getAllSnapshots() {
    const store = await tx('snapshots', 'readonly');
    return reqToPromise(store.getAll());
  },
  async saveSnapshot(snapshot) {
    const store = await tx('snapshots', 'readwrite');
    return reqToPromise(store.put(snapshot));
  },
  async deleteSnapshot(id) {
    const store = await tx('snapshots', 'readwrite');
    return reqToPromise(store.delete(id));
  },
  async getAllDividends() {
    const store = await tx('dividends', 'readonly');
    return reqToPromise(store.getAll());
  },
  async saveDividend(dividend) {
    const store = await tx('dividends', 'readwrite');
    return reqToPromise(store.put(dividend));
  },
  async deleteDividend(id) {
    const store = await tx('dividends', 'readwrite');
    return reqToPromise(store.delete(id));
  },
  async getAllTickers() {
    const store = await tx('tickers', 'readonly');
    return reqToPromise(store.getAll());
  },
  async saveTicker(ticker) {
    const store = await tx('tickers', 'readwrite');
    return reqToPromise(store.put(ticker));
  },
  async deleteTicker(name) {
    const store = await tx('tickers', 'readwrite');
    return reqToPromise(store.delete(name));
  },
  async getMeta(key) {
    const store = await tx('meta', 'readonly');
    const row = await reqToPromise(store.get(key));
    return row ? row.value : undefined;
  },
  async setMeta(key, value) {
    const store = await tx('meta', 'readwrite');
    return reqToPromise(store.put({ key, value }));
  },
  async getAllMeta() {
    const store = await tx('meta', 'readonly');
    return reqToPromise(store.getAll());
  },
  async exportAll() {
    const [brokers, snapshots, dividends, tickers, meta] = await Promise.all([
      this.getAllBrokers(), this.getAllSnapshots(), this.getAllDividends(), this.getAllTickers(), this.getAllMeta(),
    ]);
    return { version: DB_VERSION, exportedAt: new Date().toISOString(), brokers, snapshots, dividends, tickers, meta };
  },
  async importAll(data, mode = 'merge') {
    const db = await getDB();
    if (mode === 'replace') {
      await Promise.all([
        reqToPromise(db.transaction('brokers', 'readwrite').objectStore('brokers').clear()),
        reqToPromise(db.transaction('snapshots', 'readwrite').objectStore('snapshots').clear()),
        reqToPromise(db.transaction('dividends', 'readwrite').objectStore('dividends').clear()),
        reqToPromise(db.transaction('tickers', 'readwrite').objectStore('tickers').clear()),
      ]);
    }
    const brokerStore = db.transaction('brokers', 'readwrite').objectStore('brokers');
    for (const b of data.brokers || []) brokerStore.put(b);
    const snapStore = db.transaction('snapshots', 'readwrite').objectStore('snapshots');
    for (const s of data.snapshots || []) snapStore.put(s);
    const divStore = db.transaction('dividends', 'readwrite').objectStore('dividends');
    for (const d of data.dividends || []) divStore.put(d);
    const tickerStore = db.transaction('tickers', 'readwrite').objectStore('tickers');
    for (const t of data.tickers || []) tickerStore.put(t);
    const metaStore = db.transaction('meta', 'readwrite').objectStore('meta');
    for (const m of data.meta || []) metaStore.put(m);
    // A restored backup already carries the user's own accounts, so never re-seed defaults on top.
    metaStore.put({ key: 'defaultsSeeded', value: true });
  },
};

// Every write notifies listeners (used by sync.js to mirror the data to the server), so no
// view has to remember to trigger a sync itself.
const changeListeners = new Set();
export function onDataChange(fn) {
  changeListeners.add(fn);
}
for (const name of ['saveBroker', 'deleteBroker', 'saveSnapshot', 'deleteSnapshot', 'saveDividend', 'deleteDividend', 'saveTicker', 'deleteTicker', 'setMeta', 'importAll']) {
  const original = DB[name];
  DB[name] = async function (...args) {
    const result = await original.apply(DB, args);
    for (const fn of changeListeners) {
      try { fn(name); } catch (e) { console.error('data change listener failed', e); }
    }
    return result;
  };
}

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}
