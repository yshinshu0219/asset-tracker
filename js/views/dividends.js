import { DB } from '../db.js';
import {
  el, formatJPY, formatMoney, formatNumber, showToast, todayStr, costInJPY,
  latestSnapshotPerBroker, buildMonthlyDividendTotals, buildYearlyDividendTotals, trailing12MonthDividend,
  unitsPerPrice, isFundCode,
} from '../util.js';
import { refreshAllPrices } from './prices.js';
import { describeApiError } from '../api.js';

let monthlyChart = null;
let yearlyChart = null;

export function renderDividends(container, state, refresh) {
  const { brokers, snapshots, dividends, tickers = [], livePrices = {}, fxRates = {}, dividendInfo = {} } = state;
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '配当・分配金'));

  const brokerById = new Map(brokers.map((b) => [b.id, b]));
  const rows = buildYieldRows({ snapshots, tickers, livePrices, fxRates, dividendInfo, dividends, brokerById });

  const notice = renderDataNotice(state, rows);
  if (notice) container.appendChild(notice);
  container.appendChild(renderForecastSummary(rows, state, refresh));
  container.appendChild(renderYieldTable(rows, state, refresh));

  if (dividends.length > 0) {
    renderActualSections(container, { brokers: brokerById, dividends }, refresh);
  } else {
    container.appendChild(el('div', { class: 'card section-gap' }, [
      el('h2', {}, '受取配当の実績'),
      el('p', { class: 'hint' }, '配当金の入金実績を記録すると、毎月・毎年の受取額をグラフで確認できます。「CSV取込」で「配当金・分配金」を選んでCSVを取り込んでください。'),
    ]));
  }
}

// Explains an empty-looking yield table instead of just showing dashes everywhere.
function renderDataNotice(state, rows) {
  const error = state.dividendApiError;
  if (error) {
    return el('div', { class: 'card section-gap', style: 'border-color:var(--danger)' }, [
      el('h2', {}, '⚠ 配当データを取得できません'),
      el('p', { class: 'hint' }, describeApiError(error)),
    ]);
  }
  const withCode = rows.filter((r) => r.code).length;
  if (rows.length > 0 && withCode === 0) {
    return el('div', { class: 'card section-gap' }, [
      el('h2', {}, '証券コードが未設定です'),
      el('p', { class: 'hint' }, '配当を取得するには銘柄コードが必要です。「株価」画面で各銘柄にコード（例: 7203.T）を設定してください。'),
    ]);
  }
  return null;
}

// 投資信託 are left out of the yield figures: most are accumulating index funds whose 分配金 is
// 0円, so counting them as "0% yield" holdings only dilutes the averages of the stocks the yield
// is meant to describe. Recognised by their fund code, their 10,000口 unit, or the CSV's class.
function isFundHolding(item, code) {
  return isFundCode(code) || item.unitDivisor === 10000 || /投資信託|投信/.test(item.assetClass || '');
}

// One row per holding: acquisition price and current price come from the imported CSV and the
// live quote, the per-share dividend from the ticker's payment history (or a manual override).
function buildYieldRows({ snapshots, tickers, livePrices, fxRates, dividendInfo, dividends, brokerById }) {
  const tickerByName = new Map(tickers.map((t) => [t.name, t]));
  const rows = [];
  for (const snapshot of latestSnapshotPerBroker(snapshots)) {
    const broker = brokerById.get(snapshot.brokerId);
    for (const item of snapshot.items) {
      const ticker = tickerByName.get(item.name);
      const code = ticker ? ticker.code : null;
      if (isFundHolding(item, code)) continue;
      const quote = code ? livePrices[code] : null;
      const info = code ? dividendInfo[code] : null;

      const currency = item.currency && item.currency !== 'JPY' ? item.currency : 'JPY';
      const fxRate = currency === 'JPY' ? 1 : (fxRates[currency] ?? item.fxRate ?? null);

      const currentPrice = quote && !quote.error && quote.price != null ? quote.price : null;
      const unitPrice = item.unitPrice != null && !Number.isNaN(item.unitPrice) ? item.unitPrice : null;

      // A manual override wins; otherwise use the trailing 12 months of payments per share.
      const perShare = ticker && ticker.dividendPerShare != null
        ? ticker.dividendPerShare
        : (info && !info.error && info.perShareAnnual != null ? info.perShareAnnual : null);

      const quantity = item.quantity != null && !Number.isNaN(item.quantity) ? item.quantity : null;
      const annualIncomeNative = perShare != null && quantity != null ? (perShare * quantity) / unitsPerPrice(item, code) : null;
      const annualIncomeJPY = annualIncomeNative != null && fxRate != null ? annualIncomeNative * fxRate : null;

      rows.push({
        brokerName: broker ? broker.name : '?',
        color: broker ? broker.color : '#999',
        name: item.name,
        code,
        currency,
        quantity,
        unitPrice,
        currentPrice,
        perShare,
        isManual: !!(ticker && ticker.dividendPerShare != null),
        paymentsPerYear: info && info.paymentsPerYear ? info.paymentsPerYear : null,
        annualIncomeJPY,
        yieldOnCost: perShare != null && unitPrice ? (perShare / unitPrice) * 100 : null,
        currentYield: perShare != null && currentPrice ? (perShare / currentPrice) * 100 : null,
        actual12m: trailing12MonthDividend(dividends, snapshot.brokerId, item.name),
        valueJPY: item.value,
        costJPY: costInJPY(item),
      });
    }
  }
  rows.sort((a, b) => (b.currentYield ?? -1) - (a.currentYield ?? -1));
  return rows;
}

function renderForecastSummary(rows, state, refresh) {
  const withIncome = rows.filter((r) => r.annualIncomeJPY != null);
  const totalIncome = withIncome.reduce((sum, r) => sum + r.annualIncomeJPY, 0);
  const totalValue = withIncome.reduce((sum, r) => sum + (r.valueJPY || 0), 0);
  const totalCost = rows.reduce((sum, r) => (r.costJPY != null && r.perShare != null ? sum + r.costJPY : sum), 0);

  const grid = el('div', { class: 'card-grid' });
  grid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '年間配当見込み（税引前）'),
    el('div', { class: 'stat-value' }, formatJPY(totalIncome)),
    el('div', { class: 'stat-sub' }, `${withIncome.length}銘柄から算出 / 月平均 ${formatJPY(totalIncome / 12)}`),
  ]));
  grid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '平均 取得利回り'),
    el('div', { class: 'stat-value' }, totalCost > 0 ? formatNumber((totalIncome / totalCost) * 100, 2) + '%' : '-'),
    el('div', { class: 'stat-sub' }, '取得単価ベース'),
  ]));
  grid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '平均 現在利回り'),
    el('div', { class: 'stat-value' }, totalValue > 0 ? formatNumber((totalIncome / totalValue) * 100, 2) + '%' : '-'),
    el('div', { class: 'stat-sub' }, '現在の評価額ベース'),
  ]));
  return grid;
}

function renderYieldTable(rows, state, refresh) {
  const card = el('div', { class: 'card section-gap' }, [
    el('div', { class: 'inline-flex', style: 'justify-content:space-between;margin-bottom:8px;' }, [
      el('h2', { style: 'margin:0' }, '銘柄別 配当利回り'),
      el('button', {
        class: 'btn btn-sm',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = '取得中…';
          await refreshAllPrices(state, refresh);
          showToast('配当・株価を更新しました');
        },
      }, '🔄 配当データを更新'),
    ]),
    el('p', { class: 'hint' },
      '個別株（ETF・REITなど上場銘柄を含む）が対象で、投資信託は含めていません。' +
      '1株配当は直近12ヶ月の配当実績（1株あたり）から算出しています。取得利回り＝1株配当÷取得単価、現在利回り＝1株配当÷現在株価です。' +
      '増配・減配を反映したい場合は「1株配当」欄を直接書き換えると、その値で再計算されます。'
    ),
  ]);

  if (rows.length === 0) {
    card.appendChild(el('div', { class: 'empty-state' }, el('p', {}, 'まだ保有商品がありません。「CSV取込」から取り込んでください。')));
    return card;
  }

  // Six columns instead of nine: the account sits under the name, acquisition/current price
  // share a cell, and so do the two yields — so the table fits the page without side-scrolling.
  const table = el('table', { class: 'table-compact' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '銘柄 / 口座'),
      el('th', { class: 'num' }, '数量'),
      el('th', { class: 'num' }, [el('span', { class: 'pair' }, '取得単価'), el('span', { class: 'pair' }, '現在株価')]),
      el('th', { class: 'num' }, '1株配当(年)'),
      el('th', { class: 'num' }, '年間配当見込'),
      el('th', { class: 'num' }, [el('span', { class: 'pair' }, '取得利回り'), el('span', { class: 'pair' }, '現在利回り')]),
    ])),
    el('tbody', {}, rows.map((r) => renderYieldRow(r, refresh))),
  ]);
  card.appendChild(table);
  return card;
}

function renderYieldRow(r, refresh) {
  const perShareInput = el('input', {
    type: 'number',
    step: '0.0001',
    value: r.perShare != null ? String(Math.round(r.perShare * 10000) / 10000) : '',
    placeholder: r.code ? '未取得' : 'コード無',
    title: r.code ? '直接書き換えると予想配当として再計算します' : '「株価」画面で証券コードを設定すると取得できます',
    disabled: r.code ? null : 'disabled',
  });
  perShareInput.addEventListener('change', async () => {
    const parsed = parseFloat(perShareInput.value);
    const existing = { name: r.name, code: r.code };
    if (Number.isFinite(parsed) && parsed >= 0) {
      await DB.saveTicker({ ...existing, dividendPerShare: parsed });
      showToast('1株配当を保存しました');
    } else {
      await DB.saveTicker(existing); // clearing the field restores the fetched value
      showToast('自動取得の値に戻しました');
    }
    refresh();
  });

  const pct = (v) => (v != null ? formatNumber(v, 2) + '%' : '-');
  const money = (v) => (v != null ? formatMoney(v, r.currency) : '-');
  return el('tr', {}, [
    el('td', { class: 'wrap' }, [
      el('span', {}, [r.name, r.isManual ? el('span', { class: 'hint' }, ' (手動)') : null]),
      el('span', { class: 'sub' }, [el('span', { class: 'broker-dot', style: `background:${r.color}` }), r.brokerName]),
    ]),
    el('td', { class: 'num' }, r.quantity != null ? formatNumber(r.quantity, 4) : '-'),
    el('td', { class: 'num' }, [el('span', { class: 'pair' }, money(r.unitPrice)), el('span', { class: 'pair' }, money(r.currentPrice))]),
    el('td', { class: 'num' }, perShareInput),
    el('td', { class: 'num' }, r.annualIncomeJPY != null ? formatJPY(r.annualIncomeJPY) : '-'),
    el('td', { class: 'num' }, [el('span', { class: 'pair' }, pct(r.yieldOnCost)), el('span', { class: 'pair' }, pct(r.currentYield))]),
  ]);
}

// --- imported payment history (actuals) ---
function renderActualSections(container, { brokers, dividends }, refresh) {
  const thisMonth = todayStr().slice(0, 7);
  const thisYear = todayStr().slice(0, 4);
  const thisMonthTotal = dividends.filter((d) => d.date.slice(0, 7) === thisMonth).reduce((s, d) => s + d.amount, 0);
  const ytdTotal = dividends.filter((d) => d.date.slice(0, 4) === thisYear).reduce((s, d) => s + d.amount, 0);
  const monthly = buildMonthlyDividendTotals(dividends, 12);
  const trailing12Total = monthly.reduce((s, m) => s + m.total, 0);
  const yearly = buildYearlyDividendTotals(dividends);

  const statGrid = el('div', { class: 'card-grid' });
  statGrid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '今月の受取配当'),
    el('div', { class: 'stat-value' }, formatJPY(thisMonthTotal)),
    el('div', { class: 'stat-sub' }, thisMonth),
  ]));
  statGrid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '今年の受取配当（年初来）'),
    el('div', { class: 'stat-value' }, formatJPY(ytdTotal)),
    el('div', { class: 'stat-sub' }, thisYear + '年'),
  ]));
  statGrid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '直近12ヶ月の受取配当'),
    el('div', { class: 'stat-value' }, formatJPY(trailing12Total)),
    el('div', { class: 'stat-sub' }, '実績ベース'),
  ]));
  container.appendChild(el('h2', { style: 'margin:24px 0 12px' }, '受取配当の実績'));
  container.appendChild(statGrid);

  const chartsRow = el('div', { class: 'charts-row' });
  chartsRow.appendChild(el('div', { class: 'card chart-card' }, [el('h2', {}, '毎月の配当（直近12ヶ月）'), el('canvas', { id: 'monthly-dividend-chart' })]));
  chartsRow.appendChild(el('div', { class: 'card chart-card' }, [el('h2', {}, '年間の配当'), el('canvas', { id: 'yearly-dividend-chart' })]));
  container.appendChild(chartsRow);

  const sortedDividends = [...dividends].sort((a, b) => b.date.localeCompare(a.date));
  container.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, `配当明細履歴（${dividends.length}件）`),
    el('div', { class: 'preview-table-wrap', style: 'max-height:360px' }, el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '支払日'), el('th', {}, '口座'), el('th', {}, '銘柄名'), el('th', { class: 'num' }, '金額'), el('th', {}, '')])),
      el('tbody', {}, sortedDividends.map((d) => {
        const broker = brokers.get(d.brokerId);
        return el('tr', {}, [
          el('td', {}, d.date),
          el('td', {}, [el('span', { class: 'broker-dot', style: `background:${broker ? broker.color : '#999'}` }), broker ? broker.name : '(削除済み)']),
          el('td', {}, d.name),
          el('td', { class: 'num' }, formatJPY(d.amount)),
          el('td', {}, el('button', {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              if (confirm(`${d.date} ${d.name} の配当記録を削除しますか？`)) {
                await DB.deleteDividend(d.id);
                showToast('削除しました');
                refresh();
              }
            },
          }, '削除')),
        ]);
      })),
    ])),
  ]));

  requestAnimationFrame(() => {
    const monthlyCtx = document.getElementById('monthly-dividend-chart');
    if (!monthlyCtx) return;
    if (monthlyChart) monthlyChart.destroy();
    monthlyChart = new Chart(monthlyCtx, {
      type: 'bar',
      data: { labels: monthly.map((m) => m.month), datasets: [{ label: '配当', data: monthly.map((m) => m.total), backgroundColor: '#2f6fed' }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => formatJPY(v) } } } },
    });

    const yearlyCtx = document.getElementById('yearly-dividend-chart');
    if (yearlyChart) yearlyChart.destroy();
    yearlyChart = new Chart(yearlyCtx, {
      type: 'bar',
      data: { labels: yearly.map((y) => y.year + '年'), datasets: [{ label: '配当', data: yearly.map((y) => y.total), backgroundColor: '#1a9e6b' }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => formatJPY(v) } } } },
    });
  });
}
