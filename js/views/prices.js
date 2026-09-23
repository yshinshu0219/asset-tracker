import { DB } from '../db.js';
import { el, showToast, formatMoney, formatNumber, formatTime, latestSnapshotPerBroker, toMonthlySeries } from '../util.js';
import { fetchQuotes, fetchHistory, fetchFxRates, fetchDividendInfo, syncTickersToServer } from '../prices.js';
import { isCloudMode } from '../api.js';

let priceChart = null;
let selectedCode = null;
let chartMode = 'daily';

export function renderPrices(container, state, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '株価（自動取得）'));
  container.appendChild(el('p', { class: 'hint section-gap' },
    (isCloudMode() ? 'クラウド経由で' : 'ローカルサーバー（起動.bat で起動したもの）経由で') +
    'Yahoo Financeの現在値を取得します。非公式のデータ源のため、15〜20分程度遅延した値になることがあり、投資信託など銘柄コードが無いものは取得できません。' +
    '証券コードの形式：日本株 7203.T ／ 米国株 AAPL ／ 韓国株 005930.KS（KOSDAQは .KQ）／ 香港株 0700.HK'
  ));

  const latest = latestSnapshotPerBroker(state.snapshots);
  const namesInPortfolio = new Map();
  for (const s of latest) {
    for (const item of s.items) {
      if (!namesInPortfolio.has(item.name)) namesInPortfolio.set(item.name, item);
    }
  }

  if (namesInPortfolio.size === 0) {
    container.appendChild(el('div', { class: 'card empty-state' }, [
      el('div', { class: 'big' }, '📈'),
      el('p', {}, 'まだ保有商品がありません。先に「CSV取込」で保有商品を取り込んでください。'),
    ]));
    return;
  }

  const tickerByName = new Map(state.tickers.map((t) => [t.name, t]));

  // --- ticker mapping + live price table ---
  const rows = [...namesInPortfolio.entries()].map(([name, item]) => ({
    name,
    item,
    code: tickerByName.get(name)?.code || '',
  }));

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '銘柄名'), el('th', {}, '証券コード'), el('th', { class: 'num' }, '現在値'),
      el('th', {}, '取得時刻'), el('th', {}, ''),
    ])),
    el('tbody', {}, rows.map((r) => renderTickerRow(r, state, refresh))),
  ]);

  container.appendChild(el('div', { class: 'card section-gap' }, [
    el('div', { class: 'inline-flex', style: 'justify-content:space-between;margin-bottom:12px;' }, [
      el('h2', { style: 'margin:0' }, '銘柄別 現在値'),
      el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async (e) => {
          e.target.disabled = true;
          await refreshAllPrices(state, refresh);
          showToast('現在値を更新しました');
        },
      }, '🔄 すべて更新'),
    ]),
    table,
  ]));

  // --- daily history source ---
  container.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, '日次データについて'),
    el('p', { class: 'hint' }, isCloudMode()
      ? '株価の推移はYahoo Financeの過去2年分の終値を毎回取得して表示します。PC側の記録は不要です。'
      : 'Windowsのタスクスケジューラに「AssetTrackerDailyFetch」という名前でタスクを登録済みです。毎日決まった時刻に、PCが起動していればアプリを開いていなくても自動で現在値を記録します。' +
        '確認・時刻変更・削除は「タスクスケジューラ」アプリから行えます。'
    ),
  ]));

  // --- price history chart ---
  const codedRows = rows.filter((r) => r.code);
  if (codedRows.length) {
    if (!selectedCode || !codedRows.some((r) => r.code === selectedCode)) selectedCode = codedRows[0].code;

    const select = el('select', {}, codedRows.map((r) => el('option', { value: r.code, selected: r.code === selectedCode ? 'selected' : null }, `${r.name} (${r.code})`)));
    select.addEventListener('change', () => { selectedCode = select.value; renderChart(); });

    const modeSelect = el('select', {}, [
      el('option', { value: 'daily', selected: chartMode === 'daily' ? 'selected' : null }, '日次'),
      el('option', { value: 'monthly', selected: chartMode === 'monthly' ? 'selected' : null }, '月次（月末終値）'),
    ]);
    modeSelect.addEventListener('change', () => { chartMode = modeSelect.value; renderChart(); });

    const chartCard = el('div', { class: 'card chart-card' }, [
      el('div', { class: 'inline-flex', style: 'justify-content:space-between;margin-bottom:8px;' }, [
        el('h2', { style: 'margin:0' }, '株価推移'),
        el('div', { class: 'inline-flex' }, [select, modeSelect]),
      ]),
      el('canvas', { id: 'price-history-chart' }),
    ]);
    container.appendChild(chartCard);

    async function renderChart() {
      const daily = await fetchHistory(selectedCode);
      const points = chartMode === 'monthly' ? toMonthlySeries(daily).map((p) => ({ x: p.month, y: p.close })) : daily.map((p) => ({ x: p.date, y: p.close }));
      const ctx = document.getElementById('price-history-chart');
      if (!ctx) return;
      if (priceChart) priceChart.destroy();
      if (points.length === 0) {
        return;
      }
      const currency = (state.livePrices && state.livePrices[selectedCode] && state.livePrices[selectedCode].currency) || 'JPY';
      priceChart = new Chart(ctx, {
        type: 'line',
        data: { labels: points.map((p) => p.x), datasets: [{ label: '終値', data: points.map((p) => p.y), borderColor: '#2f6fed', backgroundColor: 'rgba(47,111,237,0.12)', fill: true, tension: 0.2, pointRadius: points.length < 60 ? 2 : 0 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => formatMoney(v, currency) } } } },
      });
    }
    requestAnimationFrame(renderChart);
  } else {
    container.appendChild(el('div', { class: 'card empty-state' }, [
      el('p', {}, '証券コードが登録された銘柄がまだありません。上の表でコードを入力するか、CSV取込時に証券コード列を指定してください。'),
    ]));
  }
}

function renderTickerRow(r, state, refresh) {
  const codeInput = el('input', { type: 'text', value: r.code, placeholder: '例: 7203.T / AAPL / 005930.KS', title: '日本株=.T、韓国KOSPI=.KS、KOSDAQ=.KQ、香港=.HK、米国株は記号のみ', style: 'width:150px' });
  const live = state.livePrices && state.livePrices[r.code];
  const priceCell = el('td', { class: 'num' }, live && !live.error ? formatMoney(live.price, live.currency) : (r.code ? '-' : ''));
  const timeCell = el('td', {}, live && !live.error ? formatTime(live.asOf) : (live && live.error ? el('span', { class: 'hint' }, '取得失敗') : ''));

  return el('tr', {}, [
    el('td', {}, r.name),
    el('td', {}, codeInput),
    priceCell,
    timeCell,
    el('td', {}, el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const code = codeInput.value.trim().toUpperCase();
        if (!code) { await DB.deleteTicker(r.name); } else { await DB.saveTicker({ name: r.name, code }); }
        const all = await DB.getAllTickers();
        await syncTickersToServer(all);
        showToast('保存しました');
        await refresh();
      },
    }, '保存')),
  ]);
}

async function refreshAllPrices(state, refresh) {
  const codes = state.tickers.map((t) => t.code).filter(Boolean);
  const results = await fetchQuotes(codes);
  state.livePrices = { ...state.livePrices, ...results };

  // Foreign quotes come back in their own currency, so fetch the matching FX rates too —
  // otherwise a $230 price would have to be left out of the yen total entirely.
  const foreignCurrencies = Object.values(results)
    .filter((q) => q && !q.error && q.currency && q.currency !== 'JPY')
    .map((q) => q.currency);
  if (foreignCurrencies.length) {
    const rates = await fetchFxRates(foreignCurrencies);
    state.fxRates = { ...(state.fxRates || {}), ...rates };
  }

  const dividends = await fetchDividendInfo(codes);
  state.dividendInfo = { ...(state.dividendInfo || {}), ...dividends.results };
  state.dividendApiError = dividends.error;
  await refresh();
}

export { refreshAllPrices };
