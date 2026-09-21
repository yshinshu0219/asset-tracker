import { DB, uid } from '../db.js';
import { el, showToast } from '../util.js';
import { INSTITUTION_PRESETS } from '../institutionPresets.js';

export function renderBrokers(container, { brokers }, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, '口座管理'));
  container.appendChild(el('p', { class: 'hint section-gap' },
    '家族分もまとめて管理できます。同じ証券会社でも「SBI証券（お父さん）」「SBI証券（お母さん）」のように口座ごとに登録してください。' +
    '登録した口座は「CSV取込」でCSVファイルを取り込む際に選択できます。取込画面で保存した列マッピングもここで確認・編集できます。'
  ));

  const list = el('div', {});
  for (const broker of brokers) {
    list.appendChild(renderBrokerCard(broker, refresh));
  }
  container.appendChild(list);

  container.appendChild(
    el('button', { class: 'btn btn-primary', onclick: () => openBrokerModal(null, refresh) }, '＋ 口座を追加')
  );
}

function renderBrokerCard(broker, refresh) {
  const mappedFields = Object.entries(broker.mapping || {}).filter(([, v]) => v).length;
  return el('div', { class: 'card broker-card section-gap' }, [
    el('div', {}, [
      el('div', {}, [
        el('span', { class: 'broker-dot', style: `background:${broker.color}` }),
        el('strong', {}, broker.name),
        broker.institution && broker.institution !== broker.name ? el('span', { class: 'hint' }, ` （${broker.institution}）`) : null,
      ]),
      broker.loginUrl
        ? el('div', { class: 'hint' }, [el('a', { href: broker.loginUrl, target: '_blank', rel: 'noopener' }, broker.loginUrl)])
        : null,
      broker.instructions ? el('div', { class: 'broker-instructions' }, broker.instructions) : null,
      el('div', { class: 'hint' }, `保存済み列マッピング: ${mappedFields ? mappedFields + '項目' : '未設定'}`),
    ]),
    el('div', { class: 'inline-flex' }, [
      el('button', { class: 'btn btn-sm', onclick: () => renameBroker(broker, refresh) }, '✏️ 名前を変更'),
      el('button', { class: 'btn btn-sm', onclick: () => openBrokerModal(broker, refresh) }, '編集'),
      el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: async () => {
          if (confirm(`「${broker.name}」を削除しますか？関連する取込履歴は残ります。`)) {
            await DB.deleteBroker(broker.id);
            showToast('削除しました');
            refresh();
          }
        },
      }, '削除'),
    ]),
  ]);
}

// Renaming is the most common edit for family accounts ("SBI証券" → "SBI証券（お母さん）"),
// so it gets a one-click path that doesn't touch any of the other settings.
async function renameBroker(broker, refresh) {
  const next = prompt('口座名を入力してください', broker.name);
  if (next == null) return;
  const name = next.trim();
  if (!name) { showToast('口座名を入力してください', 'error'); return; }
  if (name === broker.name) return;
  await DB.saveBroker({ ...broker, name });
  showToast(`「${name}」に変更しました`);
  refresh();
}

function openBrokerModal(existing, refresh) {
  const isNew = !existing;
  const broker = existing
    ? { ...existing }
    : {
      id: uid(),
      name: '',
      institution: '',
      holder: '',
      color: '#2f6fed',
      loginUrl: '',
      instructions: '',
      mapping: { name: null, quantity: null, unitPrice: null, value: null, currency: null, assetClass: null, code: null },
      dividendMapping: { name: null, date: null, amount: null, currency: null },
      headerRowHint: null,
    };

  const presetSelect = el('select', {}, [
    el('option', { value: '' }, isNew ? '選択してください' : '（変更しない）'),
    ...INSTITUTION_PRESETS.map((p) => el('option', { value: p.name, selected: broker.institution === p.name ? 'selected' : null }, p.name)),
    el('option', { value: '__other', selected: !isNew && broker.institution && !INSTITUTION_PRESETS.some((p) => p.name === broker.institution) ? 'selected' : null }, 'その他の証券会社・銀行'),
  ]);
  const holderInput = el('input', { type: 'text', value: broker.holder || '', placeholder: '例: お父さん / 妻 / 長男' });
  const nameInput = el('input', { type: 'text', value: broker.name, placeholder: '例: SBI証券（お父さん）' });
  const colorInput = el('input', { type: 'text', value: broker.color, placeholder: '#2f6fed' });
  const urlInput = el('input', { type: 'text', value: broker.loginUrl, placeholder: 'https://...' });
  const instrInput = el('textarea', { rows: 3, placeholder: 'CSVダウンロード手順のメモ' }, broker.instructions);

  // The account name is composed as "証券会社（名義）" until the user types their own — so a
  // second or third SBI account for another family member needs no thought about naming.
  let nameEdited = !isNew;
  nameInput.addEventListener('input', () => { nameEdited = nameInput.value.trim() !== ''; });
  const composeName = () => {
    if (nameEdited) return;
    const inst = presetSelect.value && presetSelect.value !== '__other' ? presetSelect.value : (broker.institution || '');
    const holder = holderInput.value.trim();
    nameInput.value = inst ? (holder ? `${inst}（${holder}）` : inst) : holder;
  };
  holderInput.addEventListener('input', composeName);

  presetSelect.addEventListener('change', () => {
    const preset = INSTITUTION_PRESETS.find((p) => p.name === presetSelect.value);
    if (preset) {
      broker.institution = preset.name;
      colorInput.value = preset.color;
      urlInput.value = preset.loginUrl;
      instrInput.value = preset.instructions;
    } else if (presetSelect.value === '__other') {
      broker.institution = '';
    }
    composeName();
  });

  const backdrop = el('div', { class: 'modal-backdrop' }, [
    el('div', { class: 'modal' }, [
      el('h2', {}, isNew ? '口座を追加' : '口座を編集'),
      el('p', { class: 'hint' }, '同じ証券会社の口座を家族の人数分だけ追加できます。名義を入れると口座名が自動で「証券会社（名義）」になります。'),
      el('div', { class: 'form-row' }, [el('label', {}, '証券会社'), presetSelect]),
      el('div', { class: 'form-row' }, [el('label', {}, '名義（誰の口座か）'), holderInput]),
      el('div', { class: 'form-row' }, [el('label', {}, '口座名（表示名・自由に変更できます）'), nameInput]),
      // Colour / URL / instructions are filled from the preset and almost never edited, so they
      // stay folded away — that keeps the dialog short enough that 保存 is always on screen.
      el('details', {}, [
        el('summary', {}, '詳細設定（色・URL・CSV手順メモ）'),
        el('div', { class: 'form-row' }, [el('label', {}, 'テーマカラー'), colorInput]),
        el('div', { class: 'form-row' }, [el('label', {}, 'ログイン/トップページURL'), urlInput]),
        el('div', { class: 'form-row' }, [el('label', {}, 'CSVダウンロード手順メモ'), instrInput]),
      ]),
      el('div', { class: 'actions-row' }, [
        el('button', { class: 'btn', onclick: () => backdrop.remove() }, 'キャンセル'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!nameInput.value.trim()) { showToast('口座名を入力してください', 'error'); return; }
            broker.name = nameInput.value.trim();
            broker.holder = holderInput.value.trim();
            broker.color = colorInput.value.trim() || '#2f6fed';
            broker.loginUrl = urlInput.value.trim();
            broker.instructions = instrInput.value;
            await DB.saveBroker(broker);
            backdrop.remove();
            showToast(isNew ? `「${broker.name}」を登録しました` : '保存しました');
            refresh();
          },
        }, isNew ? '登録する' : '保存'),
      ]),
    ]),
  ]);
  document.body.appendChild(backdrop);
}
