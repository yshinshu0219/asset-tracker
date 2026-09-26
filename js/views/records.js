// 過去の記録: browse the daily holdings records month by month, open any day to see exactly what
// each account held and what it was worth, and save a month as CSV for checking elsewhere.
import { el, formatJPY, formatNumber, formatMoney } from '../util.js';
import { describeApiError, isCloudMode } from '../api.js';
import { fetchRecordMonth, fetchRecordStatus, updateRecords, todayJST } from '../records.js';

const monthCache = new Map(); // 'YYYY-MM' → { records } | { error }
let month = null;             // shown month
let selectedDate = null;      // opened day
let lastRecorded = null;      // newest recorded date (any account)

export function renderRecords(container, state, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '過去の記録'));
  container.appendChild(el('p', { class: 'hint section-gap' },
    '取引日ごとに、各口座で「どの銘柄を・何株（口）・いくらで・いくら分」持っていたかを記録しています。' +
    'その日の保有内容はその日までで最新のCSV取込をもとに、その日の終値で評価したものです。' +
    '一度記録した日は、あとで取り込み直しても書き換わりません。' +
    (isCloudMode()
      ? '記録はGoogleドライブの「AssetTracker / records」フォルダに月ごとに保存されています。'
      : '記録はこのPCの「asset-tracker / data / records」フォルダに月ごとに保存されています。')
  ));

  if (!month) {
    // open on the newest recorded month (known after the first status call)
    const rerender = () => renderRecords(container, state, refresh);
    container.appendChild(el('div', { class: 'card' }, el('p', { class: 'hint' }, '記録を読み込んでいます…')));
    updateRecords(state).finally(async () => {
      const status = await fetchRecordStatus();
      const dates = status ? Object.values(status.last) : [];
      lastRecorded = dates.length ? dates.sort().at(-1) : null;
      month = (lastRecorded || todayJST()).slice(0, 7);
      monthCache.clear();
      rerender();
    });
    return;
  }

  const rerender = () => renderRecords(container, state, refresh);
  const cached = monthCache.get(month);
  if (!cached) {
    container.appendChild(renderMonthPicker(rerender));
    container.appendChild(el('div', { class: 'card' }, el('p', { class: 'hint' }, `${month.replace('-', '年')}月の記録を読み込んでいます…`)));
    fetchRecordMonth(month).then((res) => { monthCache.set(month, res); rerender(); });
    return;
  }

  container.appendChild(renderMonthPicker(rerender));
  if (cached.error) {
    container.appendChild(el('div', { class: 'card section-gap', style: 'border-color:var(--danger)' }, [
      el('h2', {}, '⚠ 記録を読み込めません'),
      el('p', { class: 'hint' }, cached.error === 'outdated-server' || cached.error === 'unknown action'
        ? 'サーバー側が古いため記録を扱えません。PCの場合は「起動.bat」を起動し直し、スマホ（クラウド）の場合はCode.gsを更新して新しいバージョンでデプロイしてください。'
        : describeApiError(cached.error)),
      el('button', { class: 'btn btn-sm', onclick: () => { monthCache.delete(month); rerender(); } }, '再試行'),
    ]));
    return;
  }

  const days = Object.keys(cached.records).sort().reverse();
  if (days.length === 0) {
    container.appendChild(el('div', { class: 'card empty-state' }, [
      el('div', { class: 'big' }, '🗓️'),
      el('p', {}, lastRecorded
        ? 'この月の記録はありません。'
        : 'まだ記録がありません。記録はCSVを取り込んだ日から始まり、アプリを開くたびに前日までの取引日の分が自動で追加されます（当日分は終値が確定する翌日に記録されます）。'),
    ]));
    return;
  }
  if (!selectedDate || !cached.records[selectedDate]) selectedDate = days[0];

  container.appendChild(renderMonthTable(days, cached.records, rerender));
  container.appendChild(renderDay(selectedDate, cached.records[selectedDate], state));
}

function renderMonthPicker(rerender) {
  const input = el('input', { type: 'month', value: month, max: todayJST().slice(0, 7) });
  input.addEventListener('change', () => { if (input.value) { month = input.value; selectedDate = null; rerender(); } });
  const shift = (delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    month = d.toISOString().slice(0, 7);
    selectedDate = null;
    rerender();
  };
  const cached = monthCache.get(month);
  return el('div', { class: 'card section-gap inline-flex', style: 'justify-content:space-between' }, [
    el('div', { class: 'inline-flex' }, [
      el('button', { class: 'btn btn-sm', onclick: () => shift(-1) }, '◀ 前月'),
      input,
      el('button', { class: 'btn btn-sm', onclick: () => shift(1), disabled: month >= todayJST().slice(0, 7) ? 'disabled' : null }, '翌月 ▶'),
    ]),
    cached && cached.records && Object.keys(cached.records).length
      ? el('button', { class: 'btn btn-sm', onclick: () => downloadCsv(month, cached.records) }, '⬇ この月をCSVで保存')
      : null,
  ]);
}

// One row per recorded day: the household total and its change from the previous record.
function renderMonthTable(days, records, rerender) {
  const totalOf = (d) => Object.values(records[d]).reduce((s, r) => s + (r.total || 0), 0);
  const rows = days.map((d, i) => {
    const total = totalOf(d);
    const prev = days[i + 1] ? totalOf(days[i + 1]) : null;
    const diff = prev != null ? total - prev : null;
    const tr = el('tr', {
      style: 'cursor:pointer;' + (d === selectedDate ? 'background:var(--accent-soft, rgba(47,111,237,0.08));font-weight:600;' : ''),
      onclick: () => { selectedDate = d; rerender(); },
    }, [
      el('td', {}, d),
      el('td', { class: 'num' }, formatJPY(total)),
      el('td', { class: 'num ' + (diff == null ? '' : diff >= 0 ? 'up' : 'down') }, diff == null ? '-' : `${diff >= 0 ? '+' : '−'}${formatJPY(Math.abs(diff))}`),
      el('td', { class: 'num' }, String(Object.keys(records[d]).length)),
    ]);
    return tr;
  });
  return el('div', { class: 'card section-gap' }, [
    el('h2', {}, `${month.replace('-', '年')}月の記録（${days.length}日）`),
    el('p', { class: 'hint' }, '日付を押すと、その日の口座ごとの保有内容を下に表示します。'),
    el('table', { class: 'table-compact' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, '日付'), el('th', { class: 'num' }, '資産合計'), el('th', { class: 'num' }, '前の記録日比'), el('th', { class: 'num' }, '口座数')])),
      el('tbody', {}, rows),
    ]),
  ]);
}

function renderDay(date, byBroker, state) {
  const colorOf = new Map(state.brokers.map((b) => [b.id, b.color]));
  const entries = Object.values(byBroker).sort((a, b) => (b.total || 0) - (a.total || 0));
  const total = entries.reduce((s, r) => s + (r.total || 0), 0);
  const wrap = el('div', { class: 'section-gap' }, [
    el('h2', { style: 'margin:4px 0 10px' }, `${date} の保有内容　合計 ${formatJPY(total)}`),
  ]);
  for (const r of entries) {
    const items = [...r.items].sort((a, b) => (b.value || 0) - (a.value || 0));
    wrap.appendChild(el('details', { class: 'card section-gap', open: entries.length === 1 ? 'open' : null }, [
      el('summary', { style: 'cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;' }, [
        el('span', {}, [
          el('span', { class: 'broker-dot', style: `background:${colorOf.get(r.brokerId) || '#999'}` }),
          el('strong', {}, r.brokerName || '(削除済みの口座)'),
          el('span', { class: 'hint' }, `　${items.length}銘柄・保有内容は ${r.snapshotDate} 取込時点`),
        ]),
        el('strong', { class: 'num' }, formatJPY(r.total)),
      ]),
      el('table', { class: 'table-compact', style: 'margin-top:8px' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, '銘柄'), el('th', { class: 'num' }, '数量'), el('th', { class: 'num' }, '終値・基準価額'), el('th', { class: 'num' }, '評価額'),
        ])),
        el('tbody', {}, items.map((it) => el('tr', {}, [
          el('td', { class: 'wrap' }, [el('span', {}, it.name), it.code ? el('span', { class: 'sub' }, it.code.startsWith('FUND:') ? '投資信託' : it.code) : null]),
          el('td', { class: 'num' }, it.quantity != null ? formatNumber(it.quantity, 4) : '-'),
          el('td', { class: 'num' }, it.fixed
            ? el('span', { class: 'hint' }, '取得できず')
            : [el('span', { class: 'pair' }, formatMoney(it.price, it.currency)), it.fx ? el('span', { class: 'sub' }, `為替 ${formatNumber(it.fx, 4)}`) : null]),
          el('td', { class: 'num' }, [el('span', { class: 'pair' }, formatJPY(it.value)), it.fixed ? el('span', { class: 'sub' }, '取込時の評価額') : null]),
        ]))),
      ]),
    ]));
  }
  return wrap;
}

// Excel-friendly CSV (UTF-8 with BOM) of every holding on every recorded day of the month.
function downloadCsv(monthKey, records) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['日付', '口座', '保有内容の取込日', '銘柄', 'コード', '数量', '終値・基準価額', '通貨', '為替', '評価額（円）', '株価取得'].join(',')];
  for (const date of Object.keys(records).sort()) {
    for (const r of Object.values(records[date])) {
      for (const it of r.items) {
        lines.push([date, r.brokerName, r.snapshotDate, it.name, it.code, it.quantity, it.price, it.currency, it.fx, it.value, it.fixed ? '取込時の評価額' : '終値'].map(esc).join(','));
      }
    }
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `資産記録_${monthKey}.csv` });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
