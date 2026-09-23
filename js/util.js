export function formatJPY(value) {
  const n = Number(value) || 0;
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

export function formatNumber(value, digits = 0) {
  const n = Number(value);
  if (Number.isNaN(n)) return '-';
  return n.toLocaleString('ja-JP', { maximumFractionDigits: digits });
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', KRW: '₩', HKD: 'HK$' };
const CURRENCY_DECIMALS = { JPY: 0, KRW: 0 }; // currencies quoted in whole units

// Formats a value in its OWN currency — never prepends ¥ to a non-JPY amount (that would
// silently mislabel e.g. a $230 price as ¥230). Use this for any raw external quote; use
// formatJPY only for amounts already converted to yen.
export function formatMoney(value, currency = 'JPY') {
  const n = Number(value) || 0;
  if (!currency || currency === 'JPY') return formatJPY(n);
  const symbol = CURRENCY_SYMBOLS[currency];
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const amount = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return symbol ? symbol + amount : amount + ' ' + currency;
}

export function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

let toastTimer = null;
export function showToast(message, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// Copies each column's header text onto its cells (data-label). On phones the CSS turns table
// rows into stacked cards and prints that label above every value, so a 6-column table stays
// readable without shrinking or side-scrolling.
export function labelTableCells(table) {
  if (!table || table.dataset.labeled === '1') return;
  // a header made of several stacked spans ("取得利回り" / "現在利回り") reads as one label
  const headers = [...table.querySelectorAll(':scope > thead th')].map((th) => {
    const parts = [...th.children].map((c) => c.textContent.trim()).filter(Boolean);
    return (parts.length > 1 ? parts.join(' / ') : th.textContent).replace(/\s*→\s*/g, ' → ').trim();
  });
  if (headers.length === 0) return;
  for (const row of table.querySelectorAll(':scope > tbody > tr')) {
    [...row.children].forEach((cell, i) => {
      if (cell.tagName !== 'TD' || cell.hasAttribute('colspan')) return;
      if (headers[i]) cell.dataset.label = headers[i];
    });
  }
  table.dataset.labeled = '1';
  table.classList.add('stack');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Given snapshots (each { brokerId, date, total }), builds a forward-filled total net-worth
// timeline: at each distinct date, sums the most recent known value per broker up to that date.
export function buildNetWorthTimeline(snapshots) {
  const byBroker = new Map();
  for (const s of snapshots) {
    if (!byBroker.has(s.brokerId)) byBroker.set(s.brokerId, []);
    byBroker.get(s.brokerId).push(s);
  }
  for (const list of byBroker.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const allDates = [...new Set(snapshots.map((s) => s.date))].sort();
  const pointers = new Map([...byBroker.keys()].map((id) => [id, -1]));

  return allDates.map((date) => {
    let total = 0;
    for (const [brokerId, list] of byBroker.entries()) {
      let p = pointers.get(brokerId);
      while (p + 1 < list.length && list[p + 1].date <= date) p++;
      pointers.set(brokerId, p);
      if (p >= 0) total += list[p].total;
    }
    return { date, total };
  });
}

export function latestSnapshotPerBroker(snapshots) {
  const byBroker = new Map();
  for (const s of snapshots) {
    const cur = byBroker.get(s.brokerId);
    if (!cur || s.date > cur.date) byBroker.set(s.brokerId, s);
  }
  return [...byBroker.values()];
}

// --- Dividend helpers ---

export function monthKey(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}

function shiftMonths(date, delta) {
  const d = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  return d;
}

function ymKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Trailing N calendar months up to and including the current month, zero-filled so the chart
// stays continuous even for months with no dividend payments.
export function buildMonthlyDividendTotals(dividends, monthsBack = 12) {
  const totals = new Map();
  for (const d of dividends) {
    const key = monthKey(d.date);
    totals.set(key, (totals.get(key) || 0) + d.amount);
  }
  const now = new Date();
  const months = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const key = ymKey(shiftMonths(now, -i));
    months.push({ month: key, total: totals.get(key) || 0 });
  }
  return months;
}

export function buildYearlyDividendTotals(dividends) {
  const totals = new Map();
  for (const d of dividends) {
    const year = d.date.slice(0, 4);
    totals.set(year, (totals.get(year) || 0) + d.amount);
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, total]) => ({ year, total }));
}

export function sumDividendsInRange(dividends, startDateExclusive, endDateInclusive) {
  return dividends
    .filter((d) => d.date > startDateExclusive && d.date <= endDateInclusive)
    .reduce((sum, d) => sum + d.amount, 0);
}

// Holdings CSVs and dividend CSVs rarely spell a name identically — one pads with spaces, the
// other uses full-width characters, a third appends "(特定)". Matching on the raw strings made
// every yield show ¥0, so compare on a normalized form instead.
export function normalizeName(name) {
  if (name == null) return '';
  return String(name)
    .normalize('NFKC')       // full-width → half-width (ＡＢＣ→ABC, １２３→123)
    .replace(/[\s　]+/g, '') // all whitespace, including the ideographic space
    .toLowerCase();
}

// Shifts an ISO 'YYYY-MM-DD' by whole months without going through Date, so the result can't
// slip a day in either direction depending on the viewer's timezone.
function shiftIsoMonths(isoDate, delta) {
  const [y, m] = isoDate.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const month = total % 12;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

// Trailing-12-month dividend total for one holding, matched by account + normalized name.
// The window ends today rather than at the holdings snapshot date: holdings are re-imported
// only occasionally, and ending the window at that stale date silently dropped every dividend
// paid since the last import.
export function trailing12MonthDividend(dividends, brokerId, name, asOfDate = todayStr()) {
  const end = asOfDate > todayStr() ? asOfDate : todayStr();
  const start = shiftIsoMonths(end, -12) + '-01';
  const target = normalizeName(name);
  return dividends
    .filter((d) => d.brokerId === brokerId && normalizeName(d.name) === target && d.date > start && d.date <= end)
    .reduce((sum, d) => sum + d.amount, 0);
}

// Acquisition cost in yen. quantity × unitPrice is in the holding's own currency and, for
// 投資信託, per 10,000 口 — so it's scaled by unitDivisor and converted with the rate stored at
// import time (older snapshots recover the rate from the converted/original value pair).
export function costInJPY(item) {
  if (item.quantity == null || item.unitPrice == null) return null;
  if (Number.isNaN(item.quantity) || Number.isNaN(item.unitPrice)) return null;
  const fxRate = item.fxRate
    || (item.currency && item.currency !== 'JPY' && item.originalValue > 0 ? item.value / item.originalValue : 1);
  return (item.quantity * item.unitPrice * fxRate) / (item.unitDivisor || 1);
}

// --- Live price / ticker helpers ---

// Best-effort conversion of a brokerage CSV's stock/fund code into a Yahoo Finance ticker.
// Numeric codes are exchange-local, so the trading currency picks the suffix: JPY → Tokyo
// (.T), KRW → Korea (.KS for KOSPI; KOSDAQ is .KQ and is resolved at registration time),
// HKD → Hong Kong (.HK, 4 digits). Anything else (already suffixed, or a US ticker like
// "AAPL") is used as-is. The result is always just a starting guess — editable in the UI.
export function guessYahooTicker(code, currency) {
  if (!code) return '';
  const trimmed = String(code).trim().toUpperCase();
  if (!trimmed) return '';
  if (/^\d+$/.test(trimmed)) {
    if (!currency || currency === 'JPY') return trimmed + '.T';
    if (currency === 'KRW') return trimmed.padStart(6, '0') + '.KS';
    if (currency === 'HKD') return trimmed.padStart(4, '0') + '.HK';
  }
  return trimmed;
}

// Reduces a daily {date, close} series to one point per month (the last trading day seen
// for that month) — used for the monthly closing-value chart.
export function toMonthlySeries(daily) {
  const byMonth = new Map();
  for (const p of daily) {
    byMonth.set(monthKey(p.date), p);
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, p]) => ({ month, close: p.close, date: p.date }));
}

export function formatTime(isoString) {
  if (!isoString) return '-';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' });
}
