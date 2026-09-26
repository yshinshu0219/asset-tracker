// Daily holdings records — "what was held, how many, at what price, worth how much" for every
// trading day, kept permanently on the PC (data/records) or in Google Drive (AssetTracker/records).
//
// The 成績 screen prices the CURRENT holdings back through time, which answers "how has what I
// hold now performed" but not "what did I actually hold back then". A record answers the
// latter: each day it uses the holdings in effect on that day (the latest import on or before
// it) valued at that day's close, and once stored it is never rewritten — so a later re-import,
// a correction, or a stock disappearing from the price source can't change the past.
//
// Records are written by the app itself: each time it opens, every trading day since the last
// record is filled in (so days the app wasn't opened are caught up from price history). Today is
// left for tomorrow, so only final closing prices are recorded.
import { api } from './api.js';
import { fetchDailySeries } from './prices.js';
import { repairSeries, forwardFillLookup, codeForItem } from './performance.js';
import { unitsPerPrice } from './util.js';

const POST_CHUNK = 40;

export function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const nextDay = (date) => addDays(date, 1);

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// the shortest price history range that reaches back to `start`
function rangeFor(start) {
  const days = daysBetween(start, todayJST());
  if (days <= 25) return '1mo';
  if (days <= 85) return '3mo';
  if (days <= 175) return '6mo';
  if (days <= 360) return '1y';
  return '2y';
}

export async function fetchRecordStatus() {
  const res = await api('recordStatus');
  return res.ok ? { first: res.firstDateByBroker || {}, last: res.lastDateByBroker || {} } : null;
}

export async function fetchRecordMonth(month) {
  const res = await api('getRecords', { month });
  return res.ok ? { records: res.records || {} } : { error: res.error || 'unknown' };
}

// Pure: turns snapshots + price history into records for the given days. Exported for testing.
//   startByBroker: { brokerId: first date that still needs a record }
//   dailySeries:   { code: { daily: [{date, close}], splits: [{date, ratio}] } }
export function buildRecords({ snapshots, tickers, brokers, dailySeries, startByBroker, endDate }) {
  const tickerByName = new Map(tickers.map((t) => [t.name, t.code]));
  const brokerName = new Map(brokers.map((b) => [b.id, b.name]));

  const priced = new Map(); // code → { lookup, splits } | null
  const seriesFor = (code) => {
    if (!code) return null;
    if (!priced.has(code)) {
      const entry = dailySeries[code];
      // rescale:false — prices stay as they were on the day, so they match that day's share count
      const daily = repairSeries(entry, code, { rescale: false }).daily;
      priced.set(code, daily && daily.length ? { lookup: forwardFillLookup(daily), splits: (entry && entry.splits) || [] } : null);
    }
    return priced.get(code);
  };

  // trading days: every date any equity / fund series has a close for (FX trades at weekends)
  const earliest = Object.values(startByBroker).reduce((a, b) => (a < b ? a : b), endDate);
  const days = new Set();
  for (const [code, entry] of Object.entries(dailySeries)) {
    if (code.endsWith('=X') || !entry || !Array.isArray(entry.daily)) continue;
    for (const p of entry.daily) if (p.date >= earliest && p.date <= endDate) days.add(p.date);
  }
  const tradingDays = [...days].sort();

  const snapsByBroker = new Map();
  for (const s of [...snapshots].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!snapsByBroker.has(s.brokerId)) snapsByBroker.set(s.brokerId, []);
    snapsByBroker.get(s.brokerId).push(s);
  }

  const records = [];
  for (const [brokerId, start] of Object.entries(startByBroker)) {
    const snaps = snapsByBroker.get(brokerId) || [];
    for (const date of tradingDays) {
      if (date < start) continue;
      // the holdings as known on that day: the latest import on or before it
      let snap = null;
      for (const s of snaps) { if (s.date <= date) snap = s; else break; }
      if (!snap) continue;

      const items = snap.items.map((item) => {
        const code = codeForItem(item, tickerByName);
        const currency = item.currency && item.currency !== 'JPY' ? item.currency : 'JPY';
        const px = item.quantity > 0 ? seriesFor(code) : null;
        const fx = currency === 'JPY' ? null : seriesFor(`${currency}JPY=X`);
        const close = px ? px.lookup(date) : null;
        const rate = currency === 'JPY' ? 1 : (fx ? fx.lookup(date) : null);
        if (close == null || rate == null) {
          // no price for this holding (投資信託 without a match, delisted, …): the imported value
          return { name: item.name, code: code || null, quantity: item.quantity ?? null, price: null, currency, fx: null, value: Math.round(item.value || 0), fixed: true };
        }
        // Yahoo back-adjusts closes for every split, so a close before a later split is shown
        // divided by its ratio — undo that to get the price actually traded that day. And a
        // split between the import and that day changed the share count the import shows.
        let priceFactor = 1;
        let qtyFactor = 1;
        for (const sp of px.splits) {
          if (sp.date > date) priceFactor *= sp.ratio;
          else if (sp.date > snap.date) qtyFactor *= sp.ratio;
        }
        const quantity = item.quantity * qtyFactor;
        const price = close * priceFactor;
        const value = (quantity * price * rate) / unitsPerPrice(item, code);
        return {
          name: item.name, code, quantity, price: Math.round(price * 10000) / 10000, currency,
          fx: currency === 'JPY' ? null : Math.round(rate * 1e6) / 1e6, value: Math.round(value), fixed: false,
        };
      });
      records.push({
        date,
        brokerId,
        brokerName: brokerName.get(brokerId) || '',
        snapshotDate: snap.date,
        total: items.reduce((sum, it) => sum + it.value, 0),
        items,
      });
    }
  }
  return records;
}

let running = null;

// Fills in every missing day up to yesterday. Safe to call often: it does nothing when up to
// date, runs once at a time, and the server refuses to overwrite a day it already has.
// Resolves to the number of records added (or null when the back end can't be reached).
export function updateRecords(state) {
  if (!running) running = doUpdate(state).finally(() => { running = null; });
  return running;
}

async function doUpdate(state) {
  if (!state.snapshots.length) return 0;
  const status = await fetchRecordStatus();
  if (status == null) return null;

  const endDate = addDays(todayJST(), -1);     // today's close isn't final yet
  const floor = addDays(todayJST(), -720);      // price history doesn't reach further back

  // A deleted account keeps its import history, but shouldn't go on being recorded every day
  const liveAccounts = new Set(state.brokers.map((b) => b.id));
  const startByBroker = {};
  for (const s of state.snapshots) {
    if (!liveAccounts.has(s.brokerId)) continue;
    const first = startByBroker[s.brokerId] == null || s.date < startByBroker[s.brokerId] ? s.date : startByBroker[s.brokerId];
    startByBroker[s.brokerId] = first;
  }
  for (const id of Object.keys(startByBroker)) {
    let start = startByBroker[id];
    // Records run unbroken from an account's first recorded day to its last, so only two
    // stretches can be missing: after the last one, and — when an older CSV has since been
    // imported with an earlier date — before the first one. In that second case everything from
    // the older import is sent; the server keeps the days it already has untouched.
    const first = status.first[id];
    const last = status.last[id];
    if (last && !(first && start < first) && nextDay(last) > start) start = nextDay(last);
    if (start < floor) start = floor;
    if (start > endDate) delete startByBroker[id];
    else startByBroker[id] = start;
  }
  const ids = Object.keys(startByBroker);
  if (!ids.length) return 0;

  // every code any snapshot in play can need (holdings that were sold since still need prices)
  const tickerByName = new Map(state.tickers.map((t) => [t.name, t.code]));
  const codes = new Set();
  for (const s of state.snapshots) {
    if (!ids.includes(s.brokerId)) continue;
    for (const item of s.items) {
      const code = codeForItem(item, tickerByName);
      if (code) codes.add(code);
      if (item.currency && item.currency !== 'JPY') codes.add(`${item.currency}JPY=X`);
    }
  }
  // a benchmark gives the trading-day calendar even for an account with no priced holdings
  codes.add('1306.T');
  const earliest = ids.map((id) => startByBroker[id]).sort()[0];
  const res = await fetchDailySeries([...codes], rangeFor(earliest));
  if (res.error) return null;

  const records = buildRecords({
    snapshots: state.snapshots, tickers: state.tickers, brokers: state.brokers,
    dailySeries: res.results, startByBroker, endDate,
  });
  let added = 0;
  const recordedAt = new Date().toISOString();
  for (let i = 0; i < records.length; i += POST_CHUNK) {
    const chunk = records.slice(i, i + POST_CHUNK).map((r) => ({ ...r, recordedAt }));
    const r = await api('addRecords', { records: chunk });
    if (!r.ok) return added || null;
    added += r.added || 0;
  }
  return added;
}
