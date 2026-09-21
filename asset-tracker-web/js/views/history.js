import { DB } from '../db.js';
import { el, formatJPY, formatNumber, showToast } from '../util.js';

export function renderHistory(container, { brokers, snapshots }, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '取込履歴'));

  if (snapshots.length === 0) {
    container.appendChild(el('div', { class: 'card empty-state' }, [el('div', { class: 'big' }, '🗂️'), el('p', {}, 'まだ取込履歴がありません。')]));
    return;
  }

  const brokerById = new Map(brokers.map((b) => [b.id, b]));
  const sorted = [...snapshots].sort((a, b) => b.date.localeCompare(a.date) || a.brokerId.localeCompare(b.brokerId));

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '日付'),
      el('th', {}, '口座'),
      el('th', { class: 'num' }, '評価額合計'),
      el('th', { class: 'num' }, '銘柄数'),
      el('th', {}, ''),
    ])),
    el('tbody', {}, sorted.map((s) => {
      const broker = brokerById.get(s.brokerId);
      const detailRow = el('tr', { class: 'detail-row', hidden: true }, el('td', { colspan: '5' }, renderItemsTable(s.items)));
      const mainRow = el('tr', {}, [
        el('td', {}, s.date),
        el('td', {}, [el('span', { class: 'broker-dot', style: `background:${broker ? broker.color : '#999'}` }), broker ? broker.name : '(削除済み)']),
        el('td', { class: 'num' }, formatJPY(s.total)),
        el('td', { class: 'num' }, String(s.items.length)),
        el('td', {}, el('div', { class: 'inline-flex' }, [
          el('button', { class: 'btn btn-sm', onclick: () => { detailRow.hidden = !detailRow.hidden; } }, '詳細'),
          el('button', {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              if (confirm(`${s.date} の ${broker ? broker.name : ''} データを削除しますか？`)) {
                await DB.deleteSnapshot(s.id);
                showToast('削除しました');
                refresh();
              }
            },
          }, '削除'),
        ])),
      ]);
      const frag = document.createDocumentFragment();
      frag.appendChild(mainRow);
      frag.appendChild(detailRow);
      return frag;
    })),
  ]);

  container.appendChild(el('div', { class: 'card' }, table));
}

function renderItemsTable(items) {
  return el('table', {}, [
    el('thead', {}, el('tr', {}, [el('th', {}, '銘柄名'), el('th', {}, '資産クラス'), el('th', { class: 'num' }, '数量'), el('th', { class: 'num' }, '評価額')])),
    el('tbody', {}, items.map((it) => el('tr', {}, [
      el('td', {}, it.name),
      el('td', {}, it.assetClass || '-'),
      el('td', { class: 'num' }, it.quantity != null && !Number.isNaN(it.quantity) ? formatNumber(it.quantity, 4) : '-'),
      el('td', { class: 'num' }, formatJPY(it.value) + (it.currency && it.currency !== 'JPY' ? ` (${it.currency} 元評価額込み換算)` : '')),
    ]))),
  ]);
}
