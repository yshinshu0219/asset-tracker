import { DB } from '../db.js';
import { el, showToast, todayStr, formatJPY, formatMoney, latestSnapshotPerBroker, guessYahooTicker } from '../util.js';
import { ensureTickersRegistered, fetchFxRates, fetchQuotes } from '../prices.js';

// Editable holdings table for one account. Loads what's already known (from the last CSV import
// or the last manual save) so a single missing field — a 取得単価 the CSV didn't carry, say —
// can be typed in without re-entering everything. Saving writes today's snapshot for the
// account, exactly like a CSV import does, so every other screen treats the data identically.

let selectedBrokerId = '';
let rows = [];
let loadedFor = null;

const CURRENCIES = ['JPY', 'USD', 'EUR'];

function blankRow() {
  return { name: '', code: '', quantity: '', unitPrice: '', currentPrice: '', currency: 'JPY' };
}

function rowsFromSnapshot(snapshot) {
  if (!snapshot) return [blankRow()];
  return snapshot.items.map((it) => {
    const divisor = it.unitDivisor || 1;
    const nativeValue = it.originalValue != null ? it.originalValue : it.value;
    // The price the last import valued this holding at — kept so that re-saving a fund (which
    // has no live quote) carries its 時価 forward instead of collapsing back to the cost basis.
    const prevPrice = it.quantity > 0 && nativeValue > 0 ? (nativeValue * divisor) / it.quantity : null;
    return {
      name: it.name || '',
      code: it.code || '',
      quantity: it.quantity != null && !Number.isNaN(it.quantity) ? String(it.quantity) : '',
      unitPrice: it.unitPrice != null && !Number.isNaN(it.unitPrice) ? String(it.unitPrice) : '',
      currentPrice: '',
      currency: it.currency || 'JPY',
      unitDivisor: divisor,
      prevPrice,
    };
  });
}

export function renderManual(container, state, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '手入力で登録・修正'));
  container.appendChild(el('p', { class: 'hint section-gap' },
    'CSVを使わずに保有銘柄を直接入力できます。CSVで取り込んだ銘柄もここに表示されるので、取得単価が読み込めなかった場合の修正にも使えます。' +
    '保存すると本日付の保有データとして記録され、ダッシュボードや配当画面に反映されます。'
  ));

  if (state.brokers.length === 0) {
    container.appendChild(el('div', { class: 'card empty-state' }, el('p', {}, '先に「口座管理」から口座を登録してください。')));
    return;
  }

  if (!selectedBrokerId || !state.brokers.some((b) => b.id === selectedBrokerId)) {
    // default to the account that was updated most recently — usually the one being worked on
    const newest = [...state.snapshots].sort((a, b) => b.date.localeCompare(a.date))[0];
    selectedBrokerId = newest && state.brokers.some((b) => b.id === newest.brokerId) ? newest.brokerId : state.brokers[0].id;
  }
  const latest = latestSnapshotPerBroker(state.snapshots).find((s) => s.brokerId === selectedBrokerId) || null;
  if (loadedFor !== selectedBrokerId) {
    rows = rowsFromSnapshot(latest);
    loadedFor = selectedBrokerId;
  }

  const select = el('select', {}, state.brokers.map((b) =>
    el('option', { value: b.id, selected: b.id === selectedBrokerId ? 'selected' : null }, b.name)));
  select.addEventListener('change', () => {
    selectedBrokerId = select.value;
    loadedFor = null;
    renderManual(container, state, refresh);
  });

  container.appendChild(el('div', { class: 'card section-gap' }, [
    el('div', { class: 'form-row' }, [el('label', {}, '口座'), select]),
    latest
      ? el('p', { class: 'hint' }, `${latest.date} 時点の保有データ（${latest.items.length}銘柄）を読み込みました。編集して保存すると本日付で上書き記録されます。`)
      : el('p', { class: 'hint' }, 'この口座にはまだ保有データがありません。下の表に入力してください。'),
  ]));

  const tickerByName = new Map(state.tickers.map((t) => [t.name, t.code]));
  const tableWrap = el('div', { class: 'preview-table-wrap', style: 'max-height:none' });
  const renderTable = () => {
    tableWrap.innerHTML = '';
    tableWrap.appendChild(el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, '銘柄名 *'), el('th', {}, '証券コード'), el('th', { class: 'num' }, '数量 *'),
        el('th', { class: 'num' }, '取得単価'), el('th', { class: 'num' }, '現在値'), el('th', {}, '通貨'), el('th', {}, ''),
      ])),
      el('tbody', {}, rows.map((r, i) => renderRow(r, i, state, tickerByName, renderTable))),
    ]));
  };
  renderTable();

  container.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, '保有銘柄'),
    el('p', { class: 'hint' }, '現在値を空欄にすると、証券コードがある銘柄は株価を自動取得して評価額を計算します。株価が取れない投資信託などは前回の評価額（それもなければ取得単価）で計算します。'),
    tableWrap,
    el('div', { class: 'actions-row' }, [
      el('button', { class: 'btn btn-sm', onclick: () => { rows.push(blankRow()); renderTable(); } }, '＋ 行を追加'),
    ]),
  ]));

  container.appendChild(el('div', { class: 'actions-row' }, [
    el('button', { class: 'btn btn-primary', onclick: () => saveRows(state, refresh) }, '本日付で保存する'),
  ]));
}

function renderRow(r, index, state, tickerByName, rerenderTable) {
  const bind = (field, attrs = {}) => {
    const input = el('input', { type: attrs.type || 'text', value: r[field], ...attrs });
    input.addEventListener('input', () => { r[field] = input.value; });
    return input;
  };
  const codeGuess = r.code || tickerByName.get(r.name) || '';
  const live = codeGuess ? state.livePrices[guessYahooTicker(codeGuess, r.currency)] : null;
  const livePlaceholder = live && !live.error && live.price != null ? `自動: ${formatMoney(live.price, live.currency)}` : '空欄なら自動';

  const currencySelect = el('select', {}, CURRENCIES.map((c) => el('option', { value: c, selected: r.currency === c ? 'selected' : null }, c)));
  currencySelect.addEventListener('change', () => { r.currency = currencySelect.value; });

  return el('tr', {}, [
    el('td', {}, bind('name', { placeholder: '例: トヨタ自動車', style: 'width:180px' })),
    el('td', {}, bind('code', { placeholder: '例: 7203 / AAPL', style: 'width:110px' })),
    el('td', { class: 'num' }, bind('quantity', { type: 'number', step: 'any', placeholder: '100', style: 'width:90px;text-align:right' })),
    el('td', { class: 'num' }, bind('unitPrice', { type: 'number', step: 'any', placeholder: '2500', style: 'width:100px;text-align:right' })),
    el('td', { class: 'num' }, bind('currentPrice', { type: 'number', step: 'any', placeholder: livePlaceholder, style: 'width:120px;text-align:right' })),
    el('td', {}, currencySelect),
    el('td', {}, el('button', { class: 'btn btn-sm btn-danger', onclick: () => { rows.splice(index, 1); if (rows.length === 0) rows.push(blankRow()); rerenderTable(); } }, '削除')),
  ]);
}

async function saveRows(state, refresh) {
  const cleaned = rows
    .map((r) => ({
      name: r.name.trim(),
      code: r.code.trim(),
      quantity: parseFloat(r.quantity),
      unitPrice: r.unitPrice === '' ? null : parseFloat(r.unitPrice),
      currentPrice: r.currentPrice === '' ? null : parseFloat(r.currentPrice),
      currency: r.currency || 'JPY',
      unitDivisor: r.unitDivisor || 1,
      prevPrice: r.prevPrice || null,
    }))
    .filter((r) => r.name || r.code || !Number.isNaN(r.quantity));

  const invalid = cleaned.find((r) => !r.name || !Number.isFinite(r.quantity) || r.quantity <= 0);
  if (invalid) { showToast('銘柄名と数量（0より大きい値）は必須です', 'error'); return; }
  if (cleaned.length === 0) { showToast('入力された銘柄がありません', 'error'); return; }

  // live prices for rows that left 現在値 blank
  const tickers = cleaned.map((r) => ({ name: r.name, code: r.code ? guessYahooTicker(r.code, r.currency) : '' }));
  const codesNeedingPrice = cleaned
    .map((r, i) => (r.currentPrice == null && tickers[i].code ? tickers[i].code : null))
    .filter(Boolean);
  const quotes = codesNeedingPrice.length ? await fetchQuotes(codesNeedingPrice) : {};

  const foreign = [...new Set(cleaned.map((r) => r.currency).filter((c) => c !== 'JPY'))];
  const rates = foreign.length ? await fetchFxRates(foreign) : {};
  const missingRate = foreign.find((c) => !(rates[c] > 0));
  if (missingRate) { showToast(`${missingRate} の為替レートを取得できませんでした。起動.bat が実行中か確認してください`, 'error'); return; }

  const items = [];
  const unpriced = [];
  cleaned.forEach((r, i) => {
    const quote = tickers[i].code ? quotes[tickers[i].code] : null;
    const livePrice = quote && !quote.error && quote.price != null ? quote.price : null;
    // typed 現在値 → live quote → the price from the previous import → acquisition price
    const price = r.currentPrice != null ? r.currentPrice
      : livePrice != null ? livePrice
      : r.prevPrice != null ? r.prevPrice
      : r.unitPrice;
    if (price == null) { unpriced.push(r.name); return; }
    const fxRate = r.currency === 'JPY' ? 1 : rates[r.currency];
    const nativeValue = (r.quantity * price) / r.unitDivisor;
    items.push({
      name: r.name,
      code: r.code,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      unitDivisor: r.unitDivisor,
      value: nativeValue * fxRate,
      originalValue: nativeValue,
      fxRate,
      currency: r.currency,
      assetClass: '',
      source: 'manual',
    });
  });
  if (unpriced.length) {
    showToast(`${unpriced.join('・')} は現在値も取得単価もないため評価額を計算できません`, 'error');
    return;
  }

  const date = todayStr();
  await DB.saveSnapshot({
    id: `${selectedBrokerId}__${date}`,
    brokerId: selectedBrokerId,
    date,
    total: items.reduce((s, it) => s + it.value, 0),
    items,
    importedAt: new Date().toISOString(),
    source: 'manual',
  });
  const guessed = tickers.filter((t) => t.code);
  if (guessed.length) await ensureTickersRegistered(guessed);

  loadedFor = null;
  showToast(`${items.length}銘柄を保存しました（合計 ${formatJPY(items.reduce((s, it) => s + it.value, 0))}）`);
  await refresh();
}
