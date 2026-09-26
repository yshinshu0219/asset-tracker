// Price / dividend / FX data via the API layer (local PC server or cloud — see api.js).
// None of this is part of the offline cache: live market data needs a live request.
import { DB } from './db.js';
import { api, isCloudMode } from './api.js';

// The local scheduled task reads its ticker list from a file the server keeps; in cloud mode
// there is no such job (history is fetched on demand), so this is a no-op there.
export async function syncTickersToServer(tickers) {
  if (isCloudMode()) return;
  await api('tickers', { tickers: tickers.map((t) => ({ name: t.name, code: t.code })) });
}

export async function fetchQuotes(codes) {
  const unique = [...new Set(codes.filter(Boolean))];
  if (unique.length === 0) return {};
  const res = await api('quote', { codes: unique });
  return res.ok ? res.results || {} : {};
}

export async function fetchHistory(code) {
  const res = await api('history', { code });
  return res.ok ? res.daily || [] : [];
}

// Per-share annual dividend for each ticker, derived from the last 12 months of payments.
// Returns { results, error } so the UI can explain *why* the numbers are missing.
export async function fetchDividendInfo(codes) {
  const unique = [...new Set(codes.filter(Boolean))];
  if (unique.length === 0) return { results: {}, error: null };
  const res = await api('dividends', { codes: unique });
  return res.ok ? { results: res.results || {}, error: null } : { results: {}, error: res.error };
}

// Daily close history for several codes at once (stocks, FX pairs, benchmark ETFs/indices).
export async function fetchDailySeries(codes, range = '2y') {
  const unique = [...new Set(codes.filter(Boolean))];
  if (unique.length === 0) return { results: {}, error: null };
  const res = await api('daily', { codes: unique, range });
  return res.ok ? { results: res.results || {}, error: null } : { results: {}, error: res.error };
}

// Live FX rate (1 unit of `currency` in yen) — Yahoo exposes FX as e.g. "USDJPY=X". Returns
// null when unavailable, so callers can ask the user instead of silently using a wrong rate.
export async function fetchFxRate(currency) {
  if (!currency || currency === 'JPY') return 1;
  const code = `${currency}JPY=X`;
  const results = await fetchQuotes([code]);
  const quote = results[code];
  if (!quote || quote.error || quote.price == null) return null;
  return quote.price;
}

export async function fetchFxRates(currencies) {
  const rates = {};
  for (const c of [...new Set(currencies)]) {
    rates[c] = await fetchFxRate(c);
  }
  return rates;
}

// A Korean code is listed on either KOSPI (.KS) or KOSDAQ (.KQ). Yahoo doesn't 404 for the
// wrong one — it returns a MUTUALFUND placeholder with a meaningless price — so both are
// queried and the one that is a real equity/ETF wins. Without instrument info (an older
// back end) the guess is kept as-is.
async function resolveKoreanTickers(guessed) {
  const korean = guessed.filter((t) => /^\d{6}\.KS$/.test(t.code));
  if (korean.length === 0) return guessed;
  const candidates = korean.flatMap((t) => [t.code, t.code.replace(/\.KS$/, '.KQ')]);
  const quotes = await fetchQuotes(candidates);
  const isListed = (q) => q && !q.error && q.price != null && (!q.instrumentType || ['EQUITY', 'ETF'].includes(q.instrumentType));
  return guessed.map((t) => {
    if (!/^\d{6}\.KS$/.test(t.code)) return t;
    const ks = quotes[t.code];
    const kq = quotes[t.code.replace(/\.KS$/, '.KQ')];
    if (isListed(ks)) return t;
    if (isListed(kq)) return { ...t, code: t.code.replace(/\.KS$/, '.KQ') };
    return t;
  });
}

// --- 投資信託 ------------------------------------------------------------------------------
// Broker CSVs carry a fund's NAME but no code, so the code is looked up in the 投資信託協会's
// fund library. Names differ slightly between the two (全角/半角, spaces, a trailing nickname
// such as "(オルカン)"), so the search is retried with trailing parentheses stripped, and only
// an unambiguous hit is accepted — a wrong fund would be worse than an unpriced one.

export async function searchFunds(keyword) {
  const res = await api('fundsearch', { q: keyword });
  return res.ok ? res.results || [] : null;
}

const fundKey = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

function fundQueries(name) {
  const queries = [];
  let q = String(name || '').normalize('NFKC').replace(/^[\[【][^\]】]*[\]】]\s*/, '').trim();
  while (q && !queries.includes(q)) {
    queries.push(q);
    const shorter = q.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (shorter === q) break;
    q = shorter;
  }
  return queries;
}

// The 基準価額 the imported value implies (per 10,000 口). Guards against a same-named but
// different fund; null when the CSV lacks the numbers.
function impliedNav(item) {
  return item.quantity > 0 && item.value > 0 ? (item.value / item.quantity) * 10000 : null;
}

export async function matchFund(item) {
  const expected = impliedNav(item);
  const plausible = (c) => !expected || !c.nav || (c.nav / expected > 0.5 && c.nav / expected < 2);
  for (const q of fundQueries(item.name)) {
    const results = await searchFunds(q);
    if (results == null) return { error: true };
    const candidates = results.filter(plausible);
    const exact = candidates.filter((c) => fundKey(c.name) === fundKey(q) || fundKey(c.name) === fundKey(item.name));
    if (exact.length === 1) return { fund: exact[0] };
    if (results.length === 1 && candidates.length === 1) return { fund: candidates[0] };
    if (results.length > 1) return { fund: null };  // ambiguous — a shorter query only widens it
  }
  return { fund: null };
}

// Names already tried without success, so each app start doesn't search them all again.
const FUND_MISS_KEY = 'assetTrackerFundMisses';
const FUND_MISS_TTL = 7 * 24 * 3600 * 1000;
function readMisses() {
  try { return JSON.parse(localStorage.getItem(FUND_MISS_KEY) || '{}'); } catch (e) { return {}; }
}
function writeMisses(m) {
  try { localStorage.setItem(FUND_MISS_KEY, JSON.stringify(m)); } catch (e) { /* not essential */ }
}

// Registers a fund code for every holding that has no code yet and matches a fund. Returns the
// number registered. Safe to call repeatedly — already-registered and recently-missed names are
// skipped.
export async function registerFundTickers(items) {
  const existing = new Set((await DB.getAllTickers()).map((t) => t.name));
  const misses = readMisses();
  const now = Date.now();
  const seen = new Set();
  let added = 0;
  for (const item of items) {
    const name = item.name;
    if (!name || seen.has(name) || existing.has(name) || item.code) continue;
    seen.add(name);
    if (!(item.quantity > 0) || (item.currency && item.currency !== 'JPY')) continue;
    if (misses[name] && now - misses[name] < FUND_MISS_TTL) continue;
    const { fund, error } = await matchFund(item);
    if (error) break;  // back end unreachable or outdated — try again next time
    if (fund) {
      await DB.saveTicker({ name, code: fund.code, fundName: fund.name });
      added++;
      delete misses[name];
    } else {
      misses[name] = now;
    }
  }
  writeMisses(misses);
  if (added) await syncTickersToServer(await DB.getAllTickers());
  return added;
}

// Ensures every holding name that has a guessed ticker code has a `tickers` DB row, without
// clobbering codes the user already edited by hand. Returns the up-to-date ticker list.
export async function ensureTickersRegistered(newlyGuessed) {
  const existing = await DB.getAllTickers();
  const existingNames = new Set(existing.map((t) => t.name));
  const fresh = newlyGuessed.filter((t) => t.code && !existingNames.has(t.name));
  const resolved = fresh.length ? await resolveKoreanTickers(fresh) : [];
  for (const t of resolved) {
    await DB.saveTicker({ name: t.name, code: t.code });
    existingNames.add(t.name);
  }
  const all = await DB.getAllTickers();
  await syncTickersToServer(all);
  return all;
}
