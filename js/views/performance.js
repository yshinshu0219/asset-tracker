import { el, formatJPY, formatNumber, formatTime, showToast, latestSnapshotPerBroker } from '../util.js';
import { fetchDailySeries } from '../prices.js';
import { loadDailyCache, saveDailyCache } from '../priceCache.js';
import { describeApiError } from '../api.js';
import { BENCHMARKS, buildValueSeries, benchmarkSeries, computeReturns, normalizeFrom, codeForItem } from '../performance.js';

let chart = null;
let benchmarkCode = BENCHMARKS[0].code;
let chartPeriod = 'ytd';       // 'mtd' | 'ytd' | '1y'
let chartTarget = 'all';       // 'all' (every account overlaid) | 'total' | brokerId
let loading = false;
let restoring = false;
let attemptedAt = 0;          // last network attempt, so a failure isn't retried on every render
let refreshError = null;      // why the last background refresh failed (cached data still shown)

const REFRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 1000;

export function renderPerformance(container, state, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '成績（前日比・月初来・年初来）'));

  if (state.snapshots.length === 0) {
    container.appendChild(el('div', { class: 'card empty-state' }, [
      el('div', { class: 'big' }, '📈'),
      el('p', {}, 'まだ保有データがありません。「CSV取込」または「手入力」で保有銘柄を登録してください。'),
    ]));
    return;
  }

  const rerender = () => renderPerformance(container, state, refresh);
  const waiting = (text) => container.appendChild(el('div', { class: 'card' }, el('p', { class: 'hint' }, text)));

  // First visit since the app opened: draw from the series saved on this device last time,
  // then bring it up to date in the background — instead of a blank screen until every one of
  // the ~80 price series has been downloaded again.
  if (!state.dailySeries) {
    if (!restoring) {
      restoring = true;
      loadDailyCache().then((saved) => {
        restoring = false;
        if (!state.dailySeries) state.dailySeries = saved || { fetchedAt: 0, results: {} };
        rerender();
      });
    }
    waiting('日次の株価データを準備しています…');
    return;
  }

  const codes = neededCodes(state);
  const cache = state.dailySeries;
  const covered = codes.every((c) => c in cache.results);
  const stale = !covered || Date.now() - cache.fetchedAt > REFRESH_MS;
  if (stale && !loading && Date.now() - attemptedAt > RETRY_MS) {
    loading = true;
    attemptedAt = Date.now();
    fetchDailySeries(codes, '2y').then((res) => {
      loading = false;
      if (res.error) {
        refreshError = res.error;
      } else {
        refreshError = null;
        state.dailySeries = { fetchedAt: Date.now(), results: { ...state.dailySeries.results, ...res.results } };
        saveDailyCache(state.dailySeries);
      }
      rerender();
    });
  }

  if (!covered) {
    if (loading) {
      waiting('日次の株価データを取得しています…（初回や銘柄を追加したときは数秒かかります）');
      return;
    }
    container.appendChild(el('div', { class: 'card section-gap', style: 'border-color:var(--danger)' }, [
      el('h2', {}, '⚠ 株価データを取得できません'),
      el('p', { class: 'hint' }, describeApiError(refreshError)),
      el('button', { class: 'btn btn-sm', onclick: () => { attemptedAt = 0; rerender(); } }, '再試行'),
    ]));
    return;
  }

  // Showing saved data: say how old it is, and whether a newer copy is on its way.
  if (loading || refreshError) {
    const asOf = cache.fetchedAt ? formatTime(new Date(cache.fetchedAt).toISOString()) : '-';
    container.appendChild(el('p', { class: 'hint section-gap' }, loading
      ? `⟳ 最新の株価を取得中です（いまの表示は ${asOf} 時点のデータ）`
      : `⚠ 最新の株価を取得できなかったため、${asOf} 時点のデータを表示しています。${describeApiError(refreshError)}`));
  }

  const series = buildValueSeries({ snapshots: state.snapshots, tickers: state.tickers, dailySeries: cache.results });
  if (series.dates.length < 2) {
    container.appendChild(el('div', { class: 'card section-gap' }, [
      el('h2', {}, '日次データのある銘柄がありません'),
      el('p', { class: 'hint' }, '成績の計算には株価を取得できる銘柄（証券コード付き）が必要です。「株価」画面で証券コードを設定するか、「手入力」でコードを入力してください。投資信託のみの場合は日々の値動きを追えません。'),
    ]));
    return;
  }

  const bench = benchmarkSeries(series.dates, cache.results, benchmarkCode);
  const benchMeta = BENCHMARKS.find((b) => b.code === benchmarkCode);
  const totalRet = computeReturns(series.dates, series.total);
  const benchRet = bench ? computeReturns(series.dates, bench) : null;

  container.appendChild(renderControls(container, state, refresh, benchMeta));
  container.appendChild(el('h2', { style: 'margin:4px 0 10px' }, '資産全体'));
  container.appendChild(renderSummaryCards(totalRet, benchRet, benchMeta));
  container.appendChild(renderChartCard(series, bench, benchMeta, state));
  container.appendChild(renderAccountCards(series, benchRet, benchMeta, state));
  container.appendChild(el('h2', { style: 'margin:4px 0 10px' }, '一覧で比較'));
  container.appendChild(renderAccountTable(series, totalRet, benchRet, benchMeta, state));
  container.appendChild(renderFixNotice(series.fixes, state));
  container.appendChild(el('p', { class: 'hint' },
    `対象期間: ${series.dates[0]} 〜 ${series.dates[series.dates.length - 1]}（${series.dates.length}営業日）。` +
    `現在の保有数量で各日の終値から評価した値です。株価を取得できる銘柄 ${series.liveItems}件が日々変動し、` +
    (series.staticItems ? `投資信託など ${series.staticItems}件は取込時の評価額で固定しています。` : '') +
    `${benchMeta.short}との比較はどちらも期間開始日を100とした指数で表示しています。`
  ));
}

// Says out loud what was corrected in the raw price data, so an odd-looking line can be told
// apart from a fix (and so a wrong correction is visible instead of silent).
function renderFixNotice(fixes, state) {
  if (!fixes || fixes.length === 0) return document.createDocumentFragment();
  const nameByCode = new Map();
  for (const t of state.tickers) if (!nameByCode.has(t.code)) nameByCode.set(t.code, t.name);
  const seen = new Set();
  const lines = [];
  for (const f of fixes) {
    const key = `${f.code}|${f.kind}|${f.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = `${nameByCode.get(f.code) || f.code}（${f.code}）`;
    lines.push(f.kind === 'split'
      ? `${label} ${f.date}：株式分割・併合の未調整を補正しました（株価を ${formatNumber(f.ratio, 4)} 倍で接続）`
      : `${label} ${f.date} から ${f.days}日分：あり得ない値だったため除外しました`);
  }
  return el('details', { class: 'card section-gap' }, [
    el('summary', {}, `株価データを自動補正しました（${lines.length}件）`),
    el('ul', { class: 'hint', style: 'margin:8px 0 0;padding-left:18px;' }, lines.map((t) => el('li', {}, t))),
  ]);
}

function neededCodes(state) {
  const tickerByName = new Map(state.tickers.map((t) => [t.name, t.code]));
  const codes = new Set([benchmarkCode]);
  for (const snap of latestSnapshotPerBroker(state.snapshots)) {
    for (const item of snap.items) {
      const code = codeForItem(item, tickerByName);
      if (code) codes.add(code);
      if (item.currency && item.currency !== 'JPY') codes.add(`${item.currency}JPY=X`);
    }
  }
  return [...codes];
}

function renderControls(container, state, refresh, benchMeta) {
  const benchSelect = el('select', {}, BENCHMARKS.map((b) => el('option', { value: b.code, selected: b.code === benchmarkCode ? 'selected' : null }, b.label)));
  benchSelect.addEventListener('change', () => { benchmarkCode = benchSelect.value; renderPerformance(container, state, refresh); });
  const reloadBtn = el('button', {
    class: 'btn btn-sm',
    onclick: () => {
      // keep the current chart on screen and fetch behind it
      state.dailySeries = { ...state.dailySeries, fetchedAt: 0 };
      attemptedAt = 0;
      renderPerformance(container, state, refresh);
      showToast('株価データを再取得します');
    },
  }, '🔄 再取得');
  return el('div', { class: 'card section-gap inline-flex', style: 'justify-content:space-between' }, [
    el('div', { class: 'inline-flex' }, [el('label', { class: 'hint' }, '比較する基準'), benchSelect]),
    reloadBtn,
  ]);
}

function signed(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '-';
  return (n >= 0 ? '+' : '−') + formatNumber(Math.abs(n), digits);
}
function signedJPY(n) {
  if (n == null || Number.isNaN(n)) return '-';
  return (n >= 0 ? '+' : '−') + formatJPY(Math.abs(n));
}
function tone(n) {
  return n == null ? '' : n >= 0 ? 'up' : 'down';
}

function renderSummaryCards(totalRet, benchRet, benchMeta) {
  const grid = el('div', { class: 'card-grid' });
  const periods = [
    { key: 'day', label: '前日比' },
    { key: 'mtd', label: '月初来' },
    { key: 'ytd', label: '年初来' },
  ];
  for (const p of periods) {
    const r = totalRet[p.key];
    const b = benchRet ? benchRet[p.key] : null;
    const diff = r && b ? r.pct - b.pct : null;
    grid.appendChild(el('div', { class: 'card stat-card' }, [
      el('div', { class: 'stat-label' }, p.label + (r && r.partial ? `（${r.baseDate}比）` : '')),
      el('div', { class: 'stat-value ' + tone(r && r.pct) }, r ? `${signed(r.pct)}%` : '-'),
      el('div', { class: 'stat-sub ' + tone(r && r.abs) }, r ? signedJPY(r.abs) : 'データ不足'),
      el('div', { class: 'stat-sub' }, b
        ? `${benchMeta.short} ${signed(b.pct)}%　差 ${signed(diff)}pt`
        : `${benchMeta.short}: データなし`),
    ]));
  }
  grid.appendChild(el('div', { class: 'card stat-card' }, [
    el('div', { class: 'stat-label' }, '現在の評価額（日次計算）'),
    el('div', { class: 'stat-value' }, formatJPY(totalRet.last)),
    el('div', { class: 'stat-sub' }, `${totalRet.lastDate} 終値時点`),
  ]));
  return grid;
}

// One card per account, so each family member's result is readable at a glance instead of
// having to pick their account from a dropdown.
function renderAccountCards(series, benchRet, benchMeta, state) {
  const brokerById = new Map(state.brokers.map((b) => [b.id, b]));
  const ids = Object.keys(series.byBroker);
  const wrap = el('div', { class: 'section-gap' }, [
    el('h2', { style: 'margin:4px 0 10px' }, `口座別の成績（${ids.length}口座）`),
  ]);
  const grid = el('div', { class: 'card-grid account-grid' });

  for (const id of ids) {
    const ret = computeReturns(series.dates, series.byBroker[id]);
    const broker = brokerById.get(id);
    const line = (label, r, benchPeriod) => {
      const diff = r && benchPeriod ? r.pct - benchPeriod.pct : null;
      return el('div', { style: 'display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-top:1px solid var(--border);' }, [
        el('span', { class: 'hint' }, label),
        el('span', { class: 'num ' + tone(r && r.pct), style: 'text-align:right' }, [
          el('span', { class: 'pair', style: 'font-weight:600' }, r ? `${signed(r.pct)}%` : '-'),
          el('span', { class: 'pair hint' }, r ? `${signedJPY(r.abs)}${diff != null ? `／${benchMeta.short}比 ${signed(diff)}pt` : ''}` : 'データ不足'),
        ]),
      ]);
    };
    grid.appendChild(el('div', { class: 'card' }, [
      el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:6px;' }, [
        el('span', { class: 'broker-dot', style: `background:${broker ? broker.color : '#999'}` }),
        el('strong', {}, broker ? broker.name : '(削除済み)'),
      ]),
      el('div', { class: 'stat-value', style: 'font-size:20px' }, formatJPY(ret.last)),
      line('前日比', ret.day, benchRet && benchRet.day),
      line('月初来', ret.mtd, benchRet && benchRet.mtd),
      line('年初来', ret.ytd, benchRet && benchRet.ytd),
    ]));
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderChartCard(series, bench, benchMeta, state) {
  const brokerById = new Map(state.brokers.map((b) => [b.id, b]));
  const accountIds = Object.keys(series.byBroker);
  if (chartTarget === 'all' && accountIds.length < 2) chartTarget = 'total';
  const targetSelect = el('select', {}, [
    accountIds.length >= 2 ? el('option', { value: 'all', selected: chartTarget === 'all' ? 'selected' : null }, '口座ごとに比較') : null,
    el('option', { value: 'total', selected: chartTarget === 'total' ? 'selected' : null }, '資産全体'),
    ...accountIds.map((id) => el('option', { value: id, selected: chartTarget === id ? 'selected' : null }, brokerById.get(id)?.name || '?')),
  ].filter(Boolean));
  const periodSelect = el('select', {}, [
    el('option', { value: 'mtd', selected: chartPeriod === 'mtd' ? 'selected' : null }, '月初来'),
    el('option', { value: 'ytd', selected: chartPeriod === 'ytd' ? 'selected' : null }, '年初来'),
    el('option', { value: '1y', selected: chartPeriod === '1y' ? 'selected' : null }, '1年'),
  ]);
  const canvas = el('canvas', { id: 'performance-chart' });
  const card = el('div', { class: 'card chart-card section-gap', style: 'height:360px' }, [
    el('div', { class: 'inline-flex', style: 'justify-content:space-between;margin-bottom:8px;' }, [
      el('h2', { style: 'margin:0' }, `値動き比較（期間開始＝100）`),
      el('div', { class: 'inline-flex' }, [targetSelect, periodSelect]),
    ]),
    canvas,
  ]);

  const draw = () => {
    // the period start is taken from the total series so every line shares one baseline
    const ret = computeReturns(series.dates, series.total);
    const lastDate = series.dates[series.dates.length - 1];
    let fromDate;
    if (chartPeriod === 'mtd') fromDate = ret.mtd ? ret.mtd.baseDate : series.dates[0];
    else if (chartPeriod === 'ytd') fromDate = ret.ytd ? ret.ytd.baseDate : series.dates[0];
    else {
      const d = new Date(lastDate + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1);
      fromDate = d.toISOString().slice(0, 10);
    }

    const lines = chartTarget === 'all'
      ? accountIds.map((id) => ({ label: brokerById.get(id)?.name || '口座', color: brokerById.get(id)?.color || '#2f6fed', values: series.byBroker[id] }))
      : [{
        label: chartTarget === 'total' ? '資産全体' : (brokerById.get(chartTarget)?.name || '口座'),
        color: chartTarget === 'total' ? '#2f6fed' : (brokerById.get(chartTarget)?.color || '#2f6fed'),
        values: chartTarget === 'total' ? series.total : (series.byBroker[chartTarget] || series.total),
      }];

    const theirs = bench ? normalizeFrom(series.dates, bench, fromDate) : [];
    const labels = (normalizeFrom(series.dates, series.total, fromDate)).map((p) => p.date);
    if (chart) chart.destroy();
    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          ...lines.map((l) => ({
            label: l.label,
            data: normalizeFrom(series.dates, l.values, fromDate).map((p) => p.value),
            borderColor: l.color, fill: false, tension: 0.2, pointRadius: 0, borderWidth: 2,
          })),
          { label: benchMeta.short, data: theirs.map((p) => p.value), borderColor: '#9aa0ac', borderDash: [6, 4], fill: false, tension: 0.2, pointRadius: 0, borderWidth: 2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.parsed.y, 2)}（${signed(ctx.parsed.y - 100)}%）` } },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
          y: { ticks: { callback: (v) => formatNumber(v, 0) } },
        },
      },
    });
  };
  targetSelect.addEventListener('change', () => { chartTarget = targetSelect.value; draw(); });
  periodSelect.addEventListener('change', () => { chartPeriod = periodSelect.value; draw(); });
  requestAnimationFrame(draw);
  return card;
}

function renderAccountTable(series, totalRet, benchRet, benchMeta, state) {
  const brokerById = new Map(state.brokers.map((b) => [b.id, b]));
  const cellFor = (r) => {
    if (!r) return el('td', { class: 'num' }, '-');
    return el('td', { class: 'num ' + tone(r.pct) }, [
      el('span', { class: 'pair' }, `${signed(r.pct)}%`),
      el('span', { class: 'pair' }, signedJPY(r.abs)),
    ]);
  };
  const rows = Object.entries(series.byBroker).map(([id, values]) => {
    const ret = computeReturns(series.dates, values);
    const broker = brokerById.get(id);
    return el('tr', {}, [
      el('td', { class: 'wrap' }, [el('span', { class: 'broker-dot', style: `background:${broker ? broker.color : '#999'}` }), broker ? broker.name : '(削除済み)']),
      el('td', { class: 'num' }, formatJPY(ret.last)),
      cellFor(ret.day), cellFor(ret.mtd), cellFor(ret.ytd),
    ]);
  });
  rows.push(el('tr', { style: 'font-weight:700;border-top:2px solid var(--border)' }, [
    el('td', {}, '合計'),
    el('td', { class: 'num' }, formatJPY(totalRet.last)),
    cellFor(totalRet.day), cellFor(totalRet.mtd), cellFor(totalRet.ytd),
  ]));
  if (benchRet) {
    const pctOnly = (r) => el('td', { class: 'num ' + tone(r && r.pct) }, r ? `${signed(r.pct)}%` : '-');
    rows.push(el('tr', { class: 'text-muted' }, [
      el('td', {}, `${benchMeta.short}（基準）`),
      el('td', { class: 'num' }, '-'),
      pctOnly(benchRet.day), pctOnly(benchRet.mtd), pctOnly(benchRet.ytd),
    ]));
  }
  return el('div', { class: 'card section-gap' }, [
    el('table', { class: 'table-compact' }, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, '口座'), el('th', { class: 'num' }, '評価額'),
        el('th', { class: 'num' }, '前日比'), el('th', { class: 'num' }, '月初来'), el('th', { class: 'num' }, '年初来'),
      ])),
      el('tbody', {}, rows),
    ]),
  ]);
}
