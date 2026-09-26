// Daily portfolio valuation + period returns (前日比 / 月初来 / 年初来) and benchmark comparison.
//
// Snapshots (CSV imports) are sparse, so a daily value series is reconstructed from the
// CURRENT holdings priced with each ticker's daily close history — "how has the portfolio I
// hold today performed", which is what portfolio apps like カビュー show. Holdings without a
// ticker (投資信託 etc.) have no daily quotes and are held flat at their last imported value, so
// they contribute to the level but not to the day-to-day movement.
import { latestSnapshotPerBroker, guessYahooTicker, unitsPerPrice } from './util.js';

// The ticker a holding is priced with: the one registered for its name (the user may have
// corrected it by hand on the 株価 screen), else one derived from the code the CSV carried —
// so a holding whose name never made it into the ticker list still moves with its price.
export function codeForItem(item, tickerByName) {
  const code = tickerByName.get(item.name) || item.code;
  return code ? guessYahooTicker(code, item.currency) || null : null;
}

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

// --- price series repair -------------------------------------------------------------------
//
// A daily close series can arrive broken in two ways, and both distort the portfolio history:
//
//  1. a decimal-shift glitch — Yahoo occasionally ships a day (or two) at 1/10 of the real
//     price, which prints as a 90% crash and an instant recovery;
//  2. an unadjusted corporate action — a 株式分割 / 株式併合 that was not back-adjusted, so the
//     series keeps the old per-share level before the date and the new one after. Pricing
//     today's share count with the old level leaves a permanent STEP in the account's line on
//     that date, which is what showed up on the SBI accounts.
//
// Both look like a close-to-close ratio that no trading day can produce: Tokyo and Seoul cap
// daily moves (値幅制限) far inside ±50%, so a ratio outside [0.5, 2] is never a market move.
// The series is cut at those breaks; a short excursion that rejoins the previous level is
// dropped as a glitch, and a lasting change of level is treated as an unadjusted split, with
// everything before it rescaled into today's share terms so the line is continuous again.
const BREAK_LOW = 0.5;
const BREAK_HIGH = 2;
const GLITCH_MAX_RUN = 3;          // longest run a decimal-shift glitch has been seen to last
const PRICE_LIMITED = /\.(T|KS|KQ)$/i;  // markets with a daily price limit

const isBreak = (ratio) => !(ratio >= BREAK_LOW && ratio <= BREAK_HIGH);

// a decimal shift moves the price by a power of ten and nothing else
const isDecimalShift = (ratio) => [0.01, 0.1, 10, 100].some((p) => Math.abs(ratio / p - 1) < 0.05);

function repairSeries(entry, code) {
  const raw = entry && Array.isArray(entry.daily)
    ? entry.daily.filter((p) => p && p.close > 0 && p.date).sort((a, b) => a.date.localeCompare(b.date))
    : [];
  if (raw.length < 3) return { daily: raw.length ? raw : null, fixes: [] };

  const segments = [[raw[0]]];  // mutated below when glitches are stitched out
  for (let i = 1; i < raw.length; i++) {
    if (isBreak(raw[i].close / raw[i - 1].close)) segments.push([raw[i]]);
    else segments[segments.length - 1].push(raw[i]);
  }
  if (segments.length === 1) return { daily: raw, fixes: [] };

  const fixes = [];
  const last = (seg) => seg[seg.length - 1].close;

  // glitches first, so a two-day decimal shift isn't mistaken for two splits in a row
  const kept = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = kept[kept.length - 1];
    const next = segments[i + 1];
    let glitch = false;
    if (seg.length <= GLITCH_MAX_RUN) {
      // removing it puts the series back together → it was never real
      if (prev && next) glitch = !isBreak(next[0].close / last(prev));
      else if (prev) glitch = isDecimalShift(seg[0].close / last(prev));
      else if (next) glitch = isDecimalShift(last(seg) / next[0].close);
    }
    if (glitch) { fixes.push({ code, kind: 'glitch', date: seg[0].date, days: seg.length }); continue; }
    // dropping a glitch usually reunites the days either side of it — join them back up so the
    // seam isn't mistaken for a corporate action below
    if (prev && !isBreak(seg[0].close / last(prev))) prev.push(...seg);
    else kept.push(seg);
  }
  if (kept.length === 0) return { daily: null, fixes };

  // Whatever breaks are left are lasting changes of level. On a price-limited market that can
  // only be an unadjusted split, so the earlier segments are restated onto the newest scale.
  // Elsewhere (US stocks, indices) a real crash of this size is possible, so they are left be.
  if (kept.length === 1 || !PRICE_LIMITED.test(code)) return { daily: kept.flat(), fixes };

  const scaled = [];
  let factor = 1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (i < kept.length - 1) {
      const ratio = kept[i + 1][0].close / last(kept[i]);
      factor *= ratio;
      fixes.push({ code, kind: 'split', date: kept[i + 1][0].date, ratio });
    }
    const seg = factor === 1 ? kept[i] : kept[i].map((p) => ({ ...p, close: p.close * factor }));
    scaled.unshift(...seg);
  }
  return { daily: scaled, fixes };
}

export function buildValueSeries({ snapshots, tickers, dailySeries }) {
  const latest = latestSnapshotPerBroker(snapshots);
  const tickerByName = new Map(tickers.map((t) => [t.name, t.code]));
  const repaired = new Map();  // code → repaired daily series (or null), computed once
  const fixes = [];
  const repairedFor = (code) => {
    if (!repaired.has(code)) {
      const r = repairSeries(dailySeries[code], code);
      repaired.set(code, r.daily);
      fixes.push(...r.fixes);
    }
    return repaired.get(code);
  };

  // which quote series each holding needs (its own ticker, plus an FX pair for foreign ones)
  const needed = new Map(); // code → lookup
  const firstDates = [];
  const seriesFor = (code) => {
    if (!code) return null;
    if (needed.has(code)) return needed.get(code);
    const daily = repairedFor(code);
    if (!daily) { needed.set(code, null); return null; }
    needed.set(code, forwardFillLookup(daily));
    firstDates.push(daily[0].date);
    return needed.get(code);
  };

  const plan = latest.map((snap) => ({
    brokerId: snap.brokerId,
    items: snap.items.map((item) => {
      const code = codeForItem(item, tickerByName);
      const currency = item.currency && item.currency !== 'JPY' ? item.currency : 'JPY';
      const priceLookup = item.quantity > 0 ? seriesFor(code) : null;
      const fxLookup = currency === 'JPY' ? null : seriesFor(`${currency}JPY=X`);
      const live = !!priceLookup && (currency === 'JPY' || !!fxLookup);
      return { item, code, priceLookup, fxLookup, live };
    }),
  }));

  // Trading-day axis: union of dates from the equity series in use, starting where all series
  // exist. FX pairs are deliberately left out of the axis — they print bars on weekends and
  // market holidays, which would create phantom "trading days" where only the yen rate moved.
  const dateSet = new Set();
  for (const [code, lookup] of needed.entries()) {
    if (!lookup || code.endsWith('=X')) continue;
    for (const p of repairedFor(code)) dateSet.add(p.date);
  }
  const startDate = firstDates.length ? firstDates.reduce((a, b) => (a > b ? a : b)) : null;
  const dates = [...dateSet].filter((d) => !startDate || d >= startDate).sort();

  const byBroker = {};
  const total = new Array(dates.length).fill(0);
  let liveItems = 0;
  let staticItems = 0;
  for (const p of plan) {
    const values = new Array(dates.length).fill(0);
    for (const { item, code, priceLookup, fxLookup, live } of p.items) {
      if (live) {
        liveItems++;
        const divisor = unitsPerPrice(item, code);
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
  return { dates, total, byBroker, liveItems, staticItems, startDate, fixes };
}

export function benchmarkSeries(dates, dailySeries, code) {
  const daily = repairSeries(dailySeries[code], code).daily;
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
