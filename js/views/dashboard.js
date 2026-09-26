import { formatJPY, formatNumber, formatMoney, formatTime, buildNetWorthTimeline, latestSnapshotPerBroker, costInJPY, el, unitsPerPrice } from '../util.js';

let lineChart = null;
let donutChart = null;

export function renderDashboard(container, { brokers, snapshots, tickers = [], livePrices = {}, fxRates = {} }) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '資産ダッシュボード'));

  if (snapshots.length === 0) {
    container.appendChild(
      el('div', { class: 'card empty-state' }, [
        el('div', { class: 'big' }, '📊'),
        el('p', {}, 'まだ資産データがありません。「CSV取込」から口座のデータを取り込みましょう。'),
      ])
    );
    return;
  }

  const brokerById = new Map(brokers.map((b) => [b.id, b]));
  const latest = latestSnapshotPerBroker(snapshots);
  const total = latest.reduce((sum, s) => sum + s.total, 0);
  const timeline = buildNetWorthTimeline(snapshots);
  const prevTotal = timeline.length > 1 ? timeline[timeline.length - 2].total : null;
  const diff = prevTotal != null ? total - prevTotal : null;

  // --- stat cards ---
  const statGrid = el('div', { class: 'card-grid' });
  statGrid.appendChild(
    el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-label' }, '総資産'),
      el('div', { class: 'stat-value' }, formatJPY(total)),
      diff != null
        ? el('div', { class: 'stat-sub ' + (diff >= 0 ? 'up' : 'down') }, (diff >= 0 ? '▲ ' : '▼ ') + formatJPY(Math.abs(diff)) + ' (前回比)')
        : el('div', { class: 'stat-sub' }, '-'),
    ])
  );
  statGrid.appendChild(
    el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-label' }, '連携中の口座'),
      el('div', { class: 'stat-value' }, String(latest.length)),
      el('div', { class: 'stat-sub' }, brokers.length + '件登録済み'),
    ])
  );
  // total unrealised profit/loss across every holding whose acquisition price is known
  let totalCost = 0;
  let valueWithCost = 0;
  for (const s of latest) {
    for (const item of s.items) {
      const cost = costInJPY(item);
      if (cost == null) continue;
      totalCost += cost;
      valueWithCost += item.value;
    }
  }
  const totalProfit = valueWithCost - totalCost;
  const profitPct = totalCost > 0 ? (totalProfit / totalCost) * 100 : null;
  statGrid.appendChild(
    el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-label' }, '評価損益'),
      el('div', { class: 'stat-value ' + (totalCost > 0 ? (totalProfit >= 0 ? 'up' : 'down') : '') },
        totalCost > 0 ? `${totalProfit >= 0 ? '+' : '−'}${formatJPY(Math.abs(totalProfit))}` : '-'),
      el('div', { class: 'stat-sub' },
        totalCost > 0 ? `取得原価 ${formatJPY(totalCost)} / ${totalProfit >= 0 ? '+' : '−'}${formatNumber(Math.abs(profitPct), 2)}%` : '取得単価が未取込です'),
    ])
  );

  const latestDate = latest.reduce((m, s) => (s.date > m ? s.date : m), latest[0]?.date || '-');
  statGrid.appendChild(
    el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-label' }, '最終更新日'),
      el('div', { class: 'stat-value' }, latestDate),
      el('div', { class: 'stat-sub' }, '取込回数: ' + snapshots.length + '回'),
    ])
  );

  // Live quotes come back in their own trading currency (e.g. USD for a US stock), so each one
  // is converted with its live FX rate before entering the yen total. Adding a raw foreign
  // price straight into a yen sum was the original "評価額がずれる" bug; when no rate is
  // available the holding falls back to the CSV's already-converted evaluation value.
  const tickerByName = new Map(tickers.map((t) => [t.name, t.code]));
  let liveTotal = 0;
  let liveCount = 0;
  let latestAsOf = null;
  for (const s of latest) {
    for (const item of s.items) {
      const code = tickerByName.get(item.name);
      const q = code && livePrices[code];
      const rate = q && !q.error ? (q.currency === 'JPY' ? 1 : fxRates[q.currency] ?? null) : null;
      const usableForTotal = q && !q.error && q.price != null && rate != null && item.quantity != null && !Number.isNaN(item.quantity);
      if (usableForTotal) {
        liveTotal += (q.price * rate * item.quantity) / unitsPerPrice(item, code);
        liveCount++;
        if (!latestAsOf || (q.asOf && q.asOf > latestAsOf)) latestAsOf = q.asOf;
      } else {
        liveTotal += item.value;
      }
    }
  }
  if (tickers.length > 0) {
    statGrid.appendChild(
      el('div', { class: 'card stat-card' }, [
        el('div', { class: 'stat-label' }, '現在値ベースの評価額'),
        el('div', { class: 'stat-value' }, formatJPY(liveTotal)),
        el('div', { class: 'stat-sub' }, liveCount > 0 ? `${liveCount}銘柄を自動取得 (${formatTime(latestAsOf)}時点)` : '「株価」画面で証券コードを設定してください'),
      ])
    );
  }
  container.appendChild(statGrid);

  // --- charts ---
  const chartsRow = el('div', { class: 'charts-row' });
  const lineCard = el('div', { class: 'card chart-card' }, [el('h2', {}, '純資産の推移'), el('canvas', { id: 'net-worth-chart' })]);
  const donutCard = el('div', { class: 'card chart-card' }, [el('h2', {}, '口座別の内訳'), el('canvas', { id: 'broker-donut-chart' })]);
  chartsRow.appendChild(lineCard);
  chartsRow.appendChild(donutCard);
  container.appendChild(chartsRow);

  // --- holdings table ---
  const items = [];
  for (const s of latest) {
    const broker = brokerById.get(s.brokerId);
    for (const item of s.items) {
      items.push({ broker: broker ? broker.name : '?', color: broker ? broker.color : '#999', ...item });
    }
  }
  items.sort((a, b) => b.value - a.value);

  const table = el('table', { class: 'table-compact' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '銘柄 / 口座'),
      el('th', { class: 'num' }, '数量'),
      el('th', { class: 'num' }, '取得原価'),
      el('th', { class: 'num' }, '評価額'),
      el('th', { class: 'num' }, '評価損益'),
      el('th', { class: 'num' }, '現在値'),
    ])),
    el('tbody', {}, items.map((it) => {
      const code = tickerByName.get(it.name);
      const q = code && livePrices[code];
      const liveCell = q && !q.error && q.price != null ? formatMoney(q.price, q.currency) : (code ? '-' : '');
      const cost = costInJPY(it);
      const profit = cost != null ? it.value - cost : null;
      const profitPct = cost ? (profit / cost) * 100 : null;
      const sign = profit != null && profit >= 0 ? '+' : '−';
      return el('tr', {}, [
        el('td', { class: 'wrap' }, [
          el('span', {}, it.name),
          el('span', { class: 'sub' }, [el('span', { class: 'broker-dot', style: `background:${it.color}` }), it.broker]),
        ]),
        el('td', { class: 'num' }, it.quantity != null && !Number.isNaN(it.quantity) ? formatNumber(it.quantity, 4) : '-'),
        el('td', { class: 'num' }, cost != null ? formatJPY(cost) : '-'),
        el('td', { class: 'num' }, [
          el('span', { class: 'pair' }, formatJPY(it.value)),
          it.currency && it.currency !== 'JPY' && it.originalValue != null ? el('span', { class: 'sub' }, `元 ${formatMoney(it.originalValue, it.currency)}`) : null,
        ]),
        profit != null
          ? el('td', { class: 'num ' + (profit >= 0 ? 'up' : 'down') }, [
            el('span', { class: 'pair' }, `${sign}${formatJPY(Math.abs(profit))}`),
            profitPct != null ? el('span', { class: 'pair' }, `${sign}${formatNumber(Math.abs(profitPct), 2)}%`) : null,
          ])
          : el('td', { class: 'num' }, '-'),
        el('td', { class: 'num' }, liveCell),
      ]);
    })),
  ]);
  container.appendChild(el('div', { class: 'card section-gap' }, [el('h2', {}, '保有銘柄一覧（最新）'), table]));

  // render charts after DOM attached
  requestAnimationFrame(() => {
    const lineCtx = document.getElementById('net-worth-chart');
    if (lineChart) lineChart.destroy();
    lineChart = new Chart(lineCtx, {
      type: 'line',
      data: {
        labels: timeline.map((t) => t.date),
        datasets: [{
          label: '総資産',
          data: timeline.map((t) => t.total),
          borderColor: '#2f6fed',
          backgroundColor: 'rgba(47,111,237,0.12)',
          fill: true,
          tension: 0.25,
          pointRadius: timeline.length < 40 ? 3 : 0,
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: (v) => formatJPY(v) } } },
      },
    });

    const donutCtx = document.getElementById('broker-donut-chart');
    if (donutChart) donutChart.destroy();
    donutChart = new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels: latest.map((s) => brokerById.get(s.brokerId)?.name || '?'),
        datasets: [{
          data: latest.map((s) => s.total),
          backgroundColor: latest.map((s) => brokerById.get(s.brokerId)?.color || '#999'),
        }],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
      },
    });
  });
}
