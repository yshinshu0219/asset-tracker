import { DB } from '../db.js';
import { el, showToast } from '../util.js';
import { pushToServer, isDirty, applyRemote } from '../sync.js';
import { api, getCloudConfig, setCloudConfig, isCloudMode, describeApiError } from '../api.js';

export function renderBackup(container, _state, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '設定・スマホで見る・バックアップ'));
  container.appendChild(renderCloudCard(container, _state, refresh));
  container.appendChild(renderShareCard());

  container.appendChild(
    el('div', { class: 'card section-gap' }, [
      el('h2', {}, 'エクスポート'),
      el('p', { class: 'hint' }, '登録した口座・資産の取込履歴・配当金記録をすべてJSONファイルとして書き出します。機種変更やブラウザデータ消去に備えて定期的に保存してください。'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const data = await DB.exportAll();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: `asset-tracker-backup-${data.exportedAt.slice(0, 10)}.json` });
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          showToast('バックアップを書き出しました');
        },
      }, '⬇ JSONをダウンロード'),
    ])
  );

  const fileInput = el('input', { type: 'file', accept: 'application/json' });
  const modeSelect = el('select', {}, [
    el('option', { value: 'merge' }, '追加(マージ)'),
    el('option', { value: 'replace' }, '置き換え(既存データを削除)'),
  ]);

  container.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, 'インポート'),
      el('p', { class: 'hint' }, 'バックアップJSONを読み込みます。「置き換え」を選ぶと現在のデータはすべて削除されます。'),
      el('div', { class: 'form-row' }, [el('label', {}, '取込モード'), modeSelect]),
      el('div', { class: 'form-row' }, [el('label', {}, 'ファイル'), fileInput]),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const file = fileInput.files[0];
          if (!file) { showToast('ファイルを選択してください', 'error'); return; }
          if (modeSelect.value === 'replace' && !confirm('現在のデータをすべて削除して置き換えます。よろしいですか？')) return;
          try {
            const text = await file.text();
            const data = JSON.parse(text);
            await DB.importAll(data, modeSelect.value);
            showToast('読み込みました');
            refresh();
          } catch (e) {
            console.error(e);
            showToast('読み込みに失敗しました: ' + e.message, 'error');
          }
        },
      }, '⬆ 読み込む'),
    ])
  );
}

// Cloud back end (Google Apps Script) connection. Saving the settings also decides which
// copy of the data survives, so the user never silently loses either side.
function renderCloudCard(container, state, refresh) {
  const cfg = getCloudConfig();
  const urlInput = el('input', { type: 'text', value: cfg ? cfg.url : '', placeholder: 'https://script.google.com/macros/s/…/exec' });
  const pwInput = el('input', { type: 'password', value: cfg ? cfg.password : '', placeholder: 'Code.gs に設定したパスワード' });
  const status = el('p', { class: 'hint' }, cfg ? '現在: クラウド接続で動作中（PCの電源に関係なく使えます）' : '現在: このPCのサーバー（起動.bat）で動作中');

  const test = async (url, password) => {
    const probe = await (async () => {
      setCloudConfig({ url, password });
      try { return await api('ping'); } finally { setCloudConfig(cfg); }
    })();
    return probe;
  };

  const card = el('div', { class: 'card section-gap' }, [
    el('h2', {}, '☁ クラウド接続（PCを切っていても使う）'),
    el('p', { class: 'hint' }, 'Google Apps Script に置いたプログラムのURLとパスワードを設定すると、データの保管と株価取得をクラウド側で行い、PCが動いていなくてもスマホから使えます。設定方法はフォルダ内の「クラウド設定手順.md」を参照してください。'),
    status,
    el('div', { class: 'form-row' }, [el('label', {}, 'ウェブアプリのURL'), urlInput]),
    el('div', { class: 'form-row' }, [el('label', {}, 'パスワード'), pwInput]),
    el('div', { class: 'actions-row' }, [
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          const url = urlInput.value.trim();
          if (!url) { showToast('URLを入力してください', 'error'); return; }
          e.target.disabled = true;
          const r = await test(url, pwInput.value);
          e.target.disabled = false;
          showToast(r.ok ? '接続できました' : describeApiError(r.error), r.ok ? 'info' : 'error');
        },
      }, '接続テスト'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async (e) => {
          const url = urlInput.value.trim();
          const password = pwInput.value;
          if (!url || !password) { showToast('URLとパスワードを入力してください', 'error'); return; }
          e.target.disabled = true;
          const probe = await test(url, password);
          if (!probe.ok) { e.target.disabled = false; showToast(describeApiError(probe.error), 'error'); return; }

          setCloudConfig({ url, password });
          const remote = await api('getData');
          const remoteData = remote.ok ? remote.data : null;
          const local = await DB.exportAll();
          const has = (d) => !!(d && ((d.brokers && d.brokers.length) || (d.snapshots && d.snapshots.length)));

          if (has(remoteData) && has(local)) {
            const useLocal = confirm(
              'クラウドにはすでにデータがあります。\n\n' +
              'OK ＝ この端末のデータでクラウドを上書きする\n' +
              'キャンセル ＝ クラウドのデータをこの端末に取り込む（この端末のデータは置き換わります）'
            );
            if (useLocal) { await pushToServer(); showToast('この端末のデータをクラウドへ送りました'); }
            else { await applyRemote(remoteData); showToast('クラウドのデータを取り込みました'); }
          } else if (has(local)) {
            await pushToServer();
            showToast('この端末のデータをクラウドへ移行しました');
          } else if (has(remoteData)) {
            await applyRemote(remoteData);
            showToast('クラウドのデータを取り込みました');
          } else {
            showToast('クラウド接続を保存しました');
          }
          // restart the app in cloud mode (re-pull, status line, price refresh)
          setTimeout(() => location.reload(), 900);
        },
      }, '保存して接続'),
      cfg ? el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          if (!confirm('クラウド接続を解除して、このPCのサーバー（起動.bat）に戻しますか？\nクラウド上のデータは削除されません。')) return;
          setCloudConfig(null);
          showToast('クラウド接続を解除しました');
          setTimeout(() => location.reload(), 900);
        },
      }, '接続を解除') : null,
    ]),
  ]);
  return card;
}

// How to open the app from a phone. In cloud mode that's simply this page's own URL; on the
// PC server it's the LAN address, plus the two things that stop it working out of the box
// (firewall, sleeping PC).
function renderShareCard() {
  const body = el('div', {}, el('p', { class: 'hint' }, '確認しています…'));
  const card = el('div', { class: 'card section-gap' }, [
    el('h2', {}, '📱 スマホ・他の端末で見る'),
    body,
  ]);

  const renderQr = (url) => {
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      return el('div', { html: qr.createSvgTag({ cellSize: 4, margin: 2 }), style: 'background:#fff;padding:6px;border-radius:8px;border:1px solid var(--border);' });
    } catch (e) {
      console.error('QR generation failed', e);
      return null;
    }
  };

  api('info').then((info) => {
    body.innerHTML = '';
    if (!info.ok) {
      body.appendChild(el('p', { class: 'hint' }, describeApiError(info.error)));
      return;
    }
    const cloud = isCloudMode();
    const url = cloud ? location.origin + location.pathname.replace(/[^/]*$/, '') : (info.lanUrls || [])[0];
    if (!url) {
      body.appendChild(el('p', { class: 'hint' }, 'このPCのWi-Fi/LANアドレスを取得できませんでした。ネットワーク接続を確認してください。'));
      return;
    }
    const row = el('div', { style: 'display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;' });
    const qr = renderQr(url);
    if (qr) row.appendChild(qr);
    row.appendChild(el('div', { style: 'flex:1;min-width:240px;' }, [
      el('p', {}, cloud ? 'スマホでこのQRコードを読み取るか、次のURLを開いてください（どこからでも使えます）：' : '同じWi-Fiにつないだスマホで、このQRコードを読み取るか次のURLを開いてください：'),
      el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener', style: 'font-size:18px;font-weight:700;word-break:break-all;' }, url)),
      el('div', { class: 'hint', style: 'line-height:1.8' }, cloud ? [
        '• スマホで開いたら、同じURLとパスワードを「クラウド接続」に入力してください',
        el('br'),
        '• ブラウザのメニューから「ホーム画面に追加」するとアプリのように使えます',
        el('br'),
        '• スマホには必ず画面ロックを設定してください（パスワードが端末内に保存されます）',
      ] : [
        '• データはこのPCの asset-tracker/data に保存され、PC・スマホどちらで編集しても共有されます',
        el('br'),
        '• PCで「起動.bat」が動いている間だけ見られます（PCがスリープ中は不可）',
        el('br'),
        '• 初回は Windows ファイアウォールの許可が必要です → フォルダ内の「スマホ接続を許可.bat」を1回実行してください',
      ]),
    ]));
    body.appendChild(row);

    const status = el('p', { class: 'hint', style: 'margin-top:12px' }, isDirty() ? '⚠ 未送信の変更があります' : `同期: 正常${info.hasData ? '' : '（まだデータなし）'}`);
    body.appendChild(status);
    body.appendChild(el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const ok = await pushToServer();
        showToast(ok ? '同期しました' : '接続できません', ok ? 'info' : 'error');
        status.textContent = ok ? '同期: 正常' : '⚠ 未送信の変更があります';
      },
    }, '🔄 今すぐ同期'));
  });

  return card;
}
