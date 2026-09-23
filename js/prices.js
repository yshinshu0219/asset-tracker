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
