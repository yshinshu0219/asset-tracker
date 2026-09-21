// Keeps every device on the same data.
//
// The browser database (IndexedDB) is per-device, so a phone opening the app would otherwise
// start empty. The server copy — data/app_data.json on the PC, or the file in Google Drive in
// cloud mode — is the shared one: on start-up the app pulls it (server wins), and every local
// write is pushed back shortly after. If the server can't be reached at write time, the change
// is flagged as pending and pushed on the next successful start — the one case where the
// local copy wins over the server.
import { DB, onDataChange } from './db.js';
import { api, beaconSetData } from './api.js';

const DIRTY_KEY = 'assetTrackerDirty';
const SYNCED_KEY = 'assetTrackerSyncedAt';
let suppress = false;
let timer = null;
let pushing = null;

const hasData = (d) => !!(d && ((d.brokers && d.brokers.length) || (d.snapshots && d.snapshots.length)));

export function initSync() {
  onDataChange(() => {
    if (suppress) return;
    localStorage.setItem(DIRTY_KEY, '1');
    clearTimeout(timer);
    timer = setTimeout(() => { pushToServer(); }, 800);
  });

  // flush anything still pending when the tab/app is closed or backgrounded
  window.addEventListener('pagehide', () => {
    if (localStorage.getItem(DIRTY_KEY) !== '1') return;
    DB.exportAll().then((data) => beaconSetData(data));
  });
}

export async function pushToServer() {
  if (pushing) return pushing;
  pushing = (async () => {
    const data = await DB.exportAll();
    const res = await api('setData', { data });
    if (res.ok) {
      if (res.updatedAt) localStorage.setItem(SYNCED_KEY, res.updatedAt);
      localStorage.removeItem(DIRTY_KEY);
      return true;
    }
    return false; // offline / unauthorized — leave the dirty flag set and try again later
  })();
  try { return await pushing; } finally { pushing = null; }
}

// Returns one of: 'pulled' (server copy applied), 'pushed' (local copy sent up),
// 'empty' (nothing anywhere yet), 'offline' (server unreachable — working locally),
// 'unauthorized' (cloud password rejected).
export async function pullFromServer() {
  const res = await api('getData');
  if (!res.ok) return res.error === 'unauthorized' || res.error === 'locked' ? 'unauthorized' : 'offline';
  const remote = res.data;

  const local = await DB.exportAll();
  const dirty = localStorage.getItem(DIRTY_KEY) === '1';

  if (dirty && hasData(local)) {
    await pushToServer();
    return 'pushed';
  }
  if (!hasData(remote)) {
    if (hasData(local)) { await pushToServer(); return 'pushed'; }
    return 'empty';
  }
  if (remote.updatedAt && remote.updatedAt === localStorage.getItem(SYNCED_KEY)) {
    return 'pulled'; // already have this exact version
  }
  await applyRemote(remote);
  return 'pulled';
}

// Replace the local copy with the server's. Used by pull, and by the cloud set-up screen when
// the user chooses to keep the cloud's data over this device's.
export async function applyRemote(remote) {
  suppress = true;
  try {
    await DB.importAll(remote, 'replace');
    localStorage.setItem(SYNCED_KEY, remote.updatedAt || '');
  } finally {
    suppress = false;
  }
}

export function isDirty() {
  return localStorage.getItem(DIRTY_KEY) === '1';
}

export function markDirty() {
  localStorage.setItem(DIRTY_KEY, '1');
}
