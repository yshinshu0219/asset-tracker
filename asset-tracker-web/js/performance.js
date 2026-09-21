// Daily portfolio valuation + period returns (前日比 / 月初来 / 年初来) and benchmark comparison.
//
// Snapshots (CSV imports) are sparse, so a daily value series is reconstructed from the
// CURRENT holdings priced with each ticker's daily close history — "how has the portfolio I
// hold today performed", which is what portfolio apps like カビュー show. Holdings without a
// ticker (投資信託 etc.) have no daily quotes and are held flat at their last imported value, so
// they contribute to the level but not to the day-to-day movement.
import { latestSnapshotPerBroker } from './util.js';

export const BENCHMARKS = [
  { code: '1306.T', label: 'TOPIX（連動ETF 1306）', short: 'TOPIX' },
  { code: '^N225', label: '日経平均株価', short: '日経平均' },
];

// Returns fn(date) → last close on or before `date`, or null if the series starts later.
function forwardFillLookup(series) {
  const dates = series.map((p) => p.date);
  return (date) => {
    let lo = 0;
    let hi = dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 ? series[found].close : null;
  };
}

// Drops obviously broken quotes. Yahoo occasionally ships a day (or two) at 1/10 of the real
// price — a decimal-shift glitch — which would print as a 90% crash on the chart and poison
// every return that spans it. A point is rejected when it sits far outside the median of its
// neighbours; a genuine sustained move shifts the median with it, so real crashes survive.
function cleanSeries(entry) {
  const raw = entry && Array.isArray(entry.daily) ? entry.daily.filter((p) => p && p.close > 0 && p.date) : [];
  if (raw.length < 5) return raw.length ? raw : null;
  const closes = raw.map((p) => p.close);
  const kept = raw.filter((p, i) => {
    const window = closes.slice(Math.max(0, i - 3), i + 4).filter((_, j) => j !== Math.min(i, 3)).sort((a, b) => a - b);
    const median = window[Math.floor(window.length / 2)];
    const ratio = p.close / median;
    return ratio > 0.4 && ratio < 2.5;
  });
  return kept.length ? kept : null;
}

export function buildValueSeries({ snapshots, tickers, dailySeries }) {
  const latest = latestSnapshotPerBroker(snapshots);
  const tickerByName = new Map(tickers.map((t) => [t.name, t.code]));

  // which quote series each holding needs (its own ticker, plus an FX pair for foreign ones)
  const needed = new Map(); // code → lookup
  const firstDates = [];
  const seriesFor = (code) => {
    if (!code) return null;
    if (needed.has(code)) return needed.get(code);
    const daily = cleanSeries(dailySeries[code]);
    if (!daily) { needed.set(code, null); return null; }
    needed.set(code, forwardFillLookup(daily));
    firstDates.push(daily[0].date);
    return needed.get(code);
  };

  const plan = latest.map((snap) => ({
    brokerId: snap.brokerId,
    items: snap.items.map((item) => {
      const code = tickerByName.get(item.name);
      const currency = item.currency && item.currency !== 'JPY' ? item.currency : 'JPY';
      const priceLookup = item.quantity > 0 ? seriesFor(code) : null;
      const fxLookup = currency === 'JPY' ? null : seriesFor(`${currency}JPY=X`);
      const live = !!priceLookup && (currency === 'JPY' || !!fxLookup);
      return { item, priceLookup, fxLookup, live };
    }),
  }));

  // Trading-day axis: union of dates from the equity series in use, starting where all series
  // exist. FX pairs are deliberately left out of the axis — they print bars on weekends and
  // market holidays, which would create phantom "trading days" where only the yen rate moved.
  const dateSet = new Set();
  for (const [code, lookup] of needed.entries()) {
    if (!lookup || code.endsWith('=X')) continue;
    for (const p of cleanSeries(dailySeries[code])) dateSet.add(p.date);
  }
  const startDate = firstDates.length ? firstDates.reduce((a, b) => (a > b ? a : b)) : null;
  const dates = [...dateSet].filter((d) => !startDate || d >= startDate).sort();

  const byBroker = {};
  const total = new Array(dates.length).fill(0);
  let liveItems = 0;
  let staticItems = 0;
  for (const p of plan) {
    const values = new Array(dates.length).fill(0);
    for (const { item, priceLookup, fxLookup, live } of p.items) {
      if (live) {
        liveItems++;
        const divisor = item.unitDivisor || 1;
        for (let i = 0; i < dates.length; i++) {
          const close = priceLookup(dates[i]);
          const fx = fxLookup ? fxLookup(dates[i]) : 1;
          values[i] += close != null && fx != null ? (item.quantity * close * fx) / divisor : item.value;
        }
      } else {
        staticItems++;
        for (let i = 0; i < dates.length; i++) values[i] += item.value;
      }
    }
    byBroker[p.brokerId] = values;
    for (let i = 0; i < dates.length; i++) total[i] += values[i];
  }
  return { dates, total, byBroker, liveItems, staticItems, startDate };
}

export function benchmarkSeries(dates, dailySeries, code) {
  const daily = cleanSeries(dailySeries[code]);
  if (!daily) return null;
  const lookup = forwardFillLookup(daily);
  return dates.map((d) => lookup(d));
}

function change(baseValue, lastValue) {
  if (baseValue == null || lastValue == null || baseValue === 0) return null;
  return { abs: lastValue - baseValue, pct: ((lastValue - baseValue) / baseValue) * 100 };
}

// Period returns against the last trading day BEFORE the period starts (前日 / 前月末 / 前年末).
// When the data doesn't reach back that far, the earliest available day is used instead and
// the result is flagged `partial` so the UI can say so.
export function computeReturns(dates, values) {
  const n = dates.length;
  if (n === 0) return null;
  const lastDate = dates[n - 1];
  const last = values[n - 1];

  const fromBoundary = (boundaryDate) => {
    let idx = -1;
    for (let i = n - 1; i >= 0; i--) { if (dates[i] < boundaryDate) { idx = i; break; } }
    const partial = idx < 0;
    const baseIdx = partial ? 0 : idx;
    if (partial && n < 2) return null;
    const c = change(values[baseIdx], last);
    return c ? { ...c, baseDate: dates[baseIdx], partial } : null;
  };

  return {
    lastDate,
    last,
    day: n >= 2 ? { ...change(values[n - 2], last), baseDate: dates[n - 2], partial: false } : null,
    mtd: fromBoundary(lastDate.slice(0, 7) + '-01'),
    ytd: fromBoundary(lastDate.slice(0, 4) + '-01-01'),
  };
}

// Rebase a series to 100 at the first non-null point on/after `fromDate`.
export function normalizeFrom(dates, values, fromDate) {
  const points = [];
  let base = null;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < fromDate || values[i] == null) continue;
    if (base == null) base = values[i];
    points.push({ date: dates[i], value: base ? (values[i] / base) * 100 : null });
  }
  return points;
}
