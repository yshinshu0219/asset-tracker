import { DB, uid } from '../db.js';
import { readCsvFileAsText, parseCsvRaw, guessHeaderRow, parseNumber, parseDateToISO } from '../csv.js';
import { el, showToast, todayStr, formatJPY, formatMoney, formatNumber, guessYahooTicker } from '../util.js';
import { ensureTickersRegistered, fetchFxRates } from '../prices.js';
import { detectSections, detectionIsComplete, describeSection, isSummaryRow, splitNameAndCode } from '../autoMap.js';

const FIELD_LABELS_BY_KIND = {
  holdings: {
    name: '銘柄名 / 商品名 (必須)',
    value: '評価額 (数量・単価から計算する場合は空欄可)',
    quantity: '数量',
    unitPrice: '単価 / 取得単価',
    currency: '通貨 (未指定はJPY扱い)',
    assetClass: '資産クラス / カテゴリ',
    code: '証券コード / 銘柄コード（現在値の自動取得に使用・任意）',
  },
  dividend: {
    name: '銘柄名 / 商品名 (必須)',
    date: '支払日 / 入金日 (必須)',
    amount: '金額 (必須)',
    currency: '通貨 (未指定はJPY扱い)',
  },
};

const KIND_LABELS = { holdings: '保有商品（評価額）', dividend: '配当金・分配金' };

// Wizard state lives at module scope so it survives re-renders while the user is on this view.
let wiz = freshWizard('holdings');

function emptyMapping(kind) {
  return kind === 'holdings'
    ? { name: null, value: null, quantity: null, unitPrice: null, currency: null, assetClass: null, code: null }
    : { name: null, date: null, amount: null, currency: null };
}

function freshWizard(kind) {
  return {
    kind,
    step: 1,
    brokerId: '',
    fileName: '',
    rawRows: [],
    headerRowIndex: 0,
    dataRows: [],
    headers: [],
    mapping: emptyMapping(kind),
    sections: [],      // auto-detected header blocks; manual mode fills this with one entry
    autoDetected: false,
    date: todayStr(),
    rates: {},
    ratesTried: [],
  };
}

// The auto-detected layout, rendered on the confirm screen so the user can see what was read
// without having to click through the mapping steps.
function renderDetectionSummary(body, state, refresh) {
  if (!wiz.autoDetected) return;
  const rows = wiz.sections.map((s, i) =>
    el('div', { class: 'hint' }, `${wiz.sections.length > 1 ? `表${i + 1}: ` : ''}${s.dataRows.length}行 — ${describeSection(s, wiz.kind)}`)
  );
  body.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, `CSVを自動で読み取りました（${wiz.fileName}）`),
    ...rows,
    el('div', { class: 'actions-row' }, [
      el('button', {
        class: 'btn btn-sm',
        onclick: () => {
          wiz.autoDetected = false;
          wiz.headerRowIndex = guessHeaderRow(wiz.rawRows);
          wiz.step = 3;
          rerender(body, state, refresh);
        },
      }, '列の対応を手動で調整する'),
    ]),
  ]));
}

export function renderImport(container, state, refresh) {
  container.innerHTML = '';
  container.appendChild(el('h1', {}, 'CSV取込'));
  container.appendChild(renderKindTabs(container, state, refresh));
  container.appendChild(renderSteps());

  const body = el('div', {});
  container.appendChild(body);

  if (wiz.step === 1) renderStep1Broker(body, state, refresh);
  else if (wiz.step === 2) renderStep2Upload(body, state, refresh);
  else if (wiz.step === 3) renderStep3Header(body, state, refresh);
  else if (wiz.step === 4) renderStep4Mapping(body, state, refresh);
  else if (wiz.step === 5) renderStep5Confirm(body, state, refresh);
}

function renderKindTabs(container, state, refresh) {
  return el('div', { class: 'steps section-gap' }, Object.entries(KIND_LABELS).map(([kind, label]) =>
    el('button', {
      class: 'step-pill ' + (wiz.kind === kind ? 'active' : ''),
      style: 'border:none;cursor:pointer;',
      onclick: () => {
        if (wiz.kind === kind) return;
        wiz = freshWizard(kind);
        renderImport(container, state, refresh);
      },
    }, label)
  ));
}

function renderSteps() {
  // Auto-detection collapses the header/mapping steps, so the indicator shows the short path.
  const labels = wiz.autoDetected
    ? ['口座選択', 'CSVアップロード', '確認・保存']
    : ['口座選択', 'CSVアップロード', 'ヘッダー行確認', '列マッピング', '確認・保存'];
  const currentStep = wiz.autoDetected && wiz.step === 5 ? 3 : wiz.step;
  return el('div', { class: 'steps' }, labels.map((label, i) => {
    const n = i + 1;
    const cls = n === currentStep ? 'active' : n < currentStep ? 'done' : '';
    return el('span', { class: 'step-pill ' + cls }, `${n}. ${label}`);
  }));
}

function rerender(container, state, refresh) {
  renderImport(container.closest('.view'), state, refresh);
}

// ---- Step 1: choose broker ----
function renderStep1Broker(body, state, refresh) {
  if (state.brokers.length === 0) {
    body.appendChild(el('div', { class: 'card empty-state' }, [
      el('p', {}, '先に「口座管理」から口座を登録してください。'),
    ]));
    return;
  }
  const select = el('select', {}, [
    el('option', { value: '' }, '選択してください'),
    ...state.brokers.map((b) => el('option', { value: b.id, selected: b.id === wiz.brokerId ? 'selected' : null }, b.name)),
  ]);
  body.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row' }, [el('label', {}, '口座'), select]),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        if (!select.value) { showToast('口座を選択してください', 'error'); return; }
        wiz.brokerId = select.value;
        wiz.step = 2;
        rerender(body, state, refresh);
      },
    }, '次へ'),
  ]));
}

// ---- Step 2: upload ----
function renderStep2Upload(body, state, refresh) {
  const broker = state.brokers.find((b) => b.id === wiz.brokerId);
  const card = el('div', { class: 'card section-gap' }, [
    el('h2', {}, broker.name + ' のCSVダウンロード手順'),
    broker.loginUrl ? el('a', { class: 'btn btn-sm', href: broker.loginUrl, target: '_blank', rel: 'noopener' }, broker.name + ' のサイトを開く ↗') : null,
    broker.instructions ? el('div', { class: 'broker-instructions' }, broker.instructions) : null,
    wiz.kind === 'dividend'
      ? el('p', { class: 'hint' }, '配当金・分配金の明細CSVをアップロードしてください（多くの証券会社では「取引履歴」「配当金・分配金明細」等のメニューからダウンロードできます）。')
      : null,
  ]);
  body.appendChild(card);

  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv' });
  const dropzone = el('div', { class: 'dropzone' }, ['📄 クリックしてCSVファイルを選択、またはドラッグ&ドロップ', fileInput]);
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    try {
      const text = await readCsvFileAsText(file);
      const rows = parseCsvRaw(text);
      if (!rows.length) { showToast('CSVを読み取れませんでした', 'error'); return; }
      wiz.rawRows = rows;
      wiz.fileName = file.name;

      // Read the whole file automatically — including files that hold several tables, which a
      // single header row could never cover. Manual mapping is only used as a fallback.
      const sections = detectSections(rows, wiz.kind);
      if (detectionIsComplete(sections, wiz.kind)) {
        wiz.sections = sections;
        wiz.autoDetected = true;
        wiz.step = 5;
        showToast(`CSVを自動で読み取りました（${sections.length}表 / ${sections.reduce((n, s) => n + s.dataRows.length, 0)}行）`);
      } else {
        wiz.autoDetected = false;
        wiz.headerRowIndex = guessHeaderRow(rows);
        wiz.step = 3;
        showToast('自動判別できなかったため、手動で列を指定してください');
      }
      rerender(body, state, refresh);
    } catch (e) {
      console.error(e);
      showToast('CSVの読み込みに失敗しました: ' + e.message, 'error');
    }
  }

  body.appendChild(el('div', { class: 'card' }, dropzone));
  body.appendChild(backButton(body, state, refresh, 1));
}

// ---- Step 3: confirm header row ----
function renderStep3Header(body, state, refresh) {
  const rows = wiz.rawRows.slice(0, 15);
  const wrap = el('div', { class: 'preview-table-wrap' });
  const table = el('table', { class: 'raw-grid' }, [
    el('tbody', {}, rows.map((row, i) => el('tr', { style: i === wiz.headerRowIndex ? 'background:var(--surface-2)' : '' }, [
      el('td', {}, el('label', { class: 'inline-flex' }, [
        el('input', {
          type: 'radio', name: 'headerRow', checked: i === wiz.headerRowIndex ? 'checked' : null,
          onchange: () => { wiz.headerRowIndex = i; rerender(body, state, refresh); },
        }),
        `${i + 1}行目`,
      ])),
      ...row.slice(0, 8).map((cell) => el('td', {}, String(cell ?? ''))),
    ]))),
  ]);
  wrap.appendChild(table);

  body.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, '見出し(ヘッダー)行を選択'),
    el('p', { class: 'hint' }, `ファイル: ${wiz.fileName} / このCSVの表の項目名（銘柄名・日付・金額など）が書かれている行を選んでください。`),
    wrap,
  ]));

  body.appendChild(el('div', { class: 'actions-row' }, [
    backButton(body, state, refresh, 2),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        const headerRow = wiz.rawRows[wiz.headerRowIndex] || [];
        wiz.headers = headerRow.map((h, i) => (h && String(h).trim()) || `列${i + 1}`);
        wiz.dataRows = wiz.rawRows.slice(wiz.headerRowIndex + 1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
        const broker = state.brokers.find((b) => b.id === wiz.brokerId);
        const savedMapping = wiz.kind === 'holdings' ? broker.mapping : broker.dividendMapping;
        wiz.mapping = autoMapFromSaved(wiz.headers, savedMapping, wiz.kind);
        wiz.step = 4;
        rerender(body, state, refresh);
      },
    }, '次へ'),
  ]));
}

function autoMapFromSaved(headers, savedMapping, kind) {
  const mapping = emptyMapping(kind);
  for (const field of Object.keys(mapping)) {
    const savedHeader = savedMapping && savedMapping[field];
    if (savedHeader) {
      const idx = headers.indexOf(savedHeader);
      if (idx >= 0) mapping[field] = idx;
    }
  }
  return mapping;
}

// ---- Step 4: column mapping ----
function renderStep4Mapping(body, state, refresh) {
  const fieldLabels = FIELD_LABELS_BY_KIND[wiz.kind];
  const card = el('div', { class: 'card section-gap' }, [
    el('h2', {}, '列の対応付け'),
    el('p', { class: 'hint' }, '各項目にどの列を使うか選んでください。次回以降、同じ列名があれば自動で対応付けされます。'),
  ]);
  const grid = el('div', { class: 'mapping-grid' });

  for (const field of Object.keys(fieldLabels)) {
    const select = el('select', {}, [
      el('option', { value: '' }, '(使用しない)'),
      ...wiz.headers.map((h, i) => el('option', { value: String(i), selected: wiz.mapping[field] === i ? 'selected' : null }, `${h}`)),
    ]);
    select.addEventListener('change', () => {
      wiz.mapping[field] = select.value === '' ? null : Number(select.value);
    });
    grid.appendChild(el('label', {}, fieldLabels[field]));
    grid.appendChild(select);
  }
  card.appendChild(grid);
  body.appendChild(card);

  // small preview of first 5 data rows
  const previewRows = wiz.dataRows.slice(0, 5);
  body.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, 'データプレビュー（先頭5行）'),
    el('div', { class: 'preview-table-wrap' }, el('table', { class: 'raw-grid' }, [
      el('thead', {}, el('tr', {}, wiz.headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, previewRows.map((row) => el('tr', {}, wiz.headers.map((_, i) => el('td', {}, String(row[i] ?? '')))))),
    ])),
  ]));

  body.appendChild(el('div', { class: 'actions-row' }, [
    backButton(body, state, refresh, 3),
    el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        if (wiz.mapping.name == null) { showToast('銘柄名の列を選択してください', 'error'); return; }
        if (wiz.kind === 'holdings') {
          if (wiz.mapping.value == null && (wiz.mapping.quantity == null || wiz.mapping.unitPrice == null)) {
            showToast('評価額の列、または数量と単価の両方の列を選択してください', 'error');
            return;
          }
        } else {
          if (wiz.mapping.date == null) { showToast('支払日の列を選択してください', 'error'); return; }
          if (wiz.mapping.amount == null) { showToast('金額の列を選択してください', 'error'); return; }
        }
        // Manual mapping is just a one-section version of what auto-detection produces.
        wiz.sections = [{ headers: wiz.headers, dataRows: wiz.dataRows, mapping: { ...wiz.mapping }, unitDivisor: 1 }];
        wiz.step = 5;
        rerender(body, state, refresh);
      },
    }, '次へ'),
  ]));
}

// ---- Step 5: confirm + save ----
const cell = (row, idx) => (idx != null ? String(row[idx] ?? '').trim() : '');

function computeHoldingItems() {
  const items = [];
  let skipped = 0;
  for (const section of wiz.sections) {
    const m = section.mapping;
    for (const row of section.dataRows) {
      const rawName = cell(row, m.name);
      // 合計 / 小計 rows would otherwise be counted as another holding, doubling the total.
      if (!rawName || isSummaryRow(rawName)) { skipped++; continue; }
      const split = splitNameAndCode(rawName);
      const name = split.name;
      const num = (idx) => (idx != null ? parseNumber(row[idx]) : NaN);
      const quantity = Number.isNaN(num(m.quantity)) ? null : num(m.quantity);
      const currentPrice = Number.isNaN(num(m.currentPrice)) ? null : num(m.currentPrice);
      let value = num(m.value);

      const priced = resolveUnitPrice({
        quantity,
        unitPrice: Number.isNaN(num(m.unitPrice)) ? null : num(m.unitPrice),
        costTotal: Number.isNaN(num(m.costTotal)) ? null : num(m.costTotal),
        value: Number.isNaN(value) ? null : value,
        isFund: !!section.isFund,
      });

      if (Number.isNaN(value) && quantity != null) {
        const price = currentPrice != null ? currentPrice : priced.unitPrice;
        if (price != null) value = (quantity * price) / priced.unitDivisor;
      }
      if (Number.isNaN(value)) { skipped++; continue; }
      const currency = m.currency != null ? cell(row, m.currency).toUpperCase() || 'JPY' : 'JPY';
      items.push({
        name,
        quantity,
        unitPrice: priced.unitPrice,
        unitDivisor: priced.unitDivisor,
        value,
        currency: normalizeCurrency(currency),
        assetClass: cell(row, m.assetClass),
        code: cell(row, m.code) || split.code,
      });
    }
  }
  return { items, skipped };
}

// Works out the per-unit acquisition price and the unit scale for one row.
//   - A total-cost column (取得金額) becomes a unit price by dividing by the quantity.
//   - 投資信託 quote prices per 10,000 口, so quantity × price is 10,000x the real amount;
//     the ratio against the evaluation value reveals which scale the file used, regardless of
//     what the headers happened to be called.
function resolveUnitPrice({ quantity, unitPrice, costTotal, value, isFund }) {
  let price = unitPrice;
  if (price == null && costTotal != null && quantity > 0) price = costTotal / quantity;
  if (price == null) return { unitPrice: null, unitDivisor: isFund ? 10000 : 1 };

  let unitDivisor = isFund ? 10000 : 1;
  if (value > 0 && quantity > 0) {
    const ratio = (quantity * price) / value;
    if (ratio > 0.1 && ratio < 10) unitDivisor = 1;
    else if (ratio > 1000 && ratio < 100000) unitDivisor = 10000;
    else if (price / value > 0.1 && price / value < 10 && quantity > 1) {
      // the "unit price" column actually held the total cost
      price = price / quantity;
      unitDivisor = 1;
    }
  }
  return { unitPrice: price, unitDivisor };
}

// Brokerage CSVs write yen as 円 / 日本円 / JPY interchangeably. Treating 円 as a foreign
// currency made the importer demand an exchange rate for plain yen holdings.
function normalizeCurrency(raw) {
  const v = String(raw || '').normalize('NFKC').replace(/[\s　]/g, '').toUpperCase();
  if (!v) return 'JPY';
  if (['円', '日本円', 'JPY', '¥', '￥'].includes(v)) return 'JPY';
  if (['米ドル', 'ドル', 'USドル', 'USD', '$'].includes(v)) return 'USD';
  if (['ユーロ', 'EUR', '€'].includes(v)) return 'EUR';
  if (['ウォン', '韓国ウォン', 'KRW', '₩'].includes(v)) return 'KRW';
  if (['香港ドル', 'HKD', 'HK$'].includes(v)) return 'HKD';
  if (['ポンド', '英ポンド', 'GBP', '£'].includes(v)) return 'GBP';
  return v;
}

function computeDividendItems() {
  const items = [];
  let skipped = 0;
  for (const section of wiz.sections) {
    const m = section.mapping;
    for (const row of section.dataRows) {
      const name = cell(row, m.name);
      const date = m.date != null ? parseDateToISO(row[m.date]) : null;
      const amount = m.amount != null ? parseNumber(row[m.amount]) : NaN;
      if (!name || isSummaryRow(name) || !date || Number.isNaN(amount)) { skipped++; continue; }
      const currency = m.currency != null ? cell(row, m.currency).toUpperCase() || 'JPY' : 'JPY';
      items.push({ name, date, amount, currency: normalizeCurrency(currency) });
    }
  }
  return { items, skipped };
}

function renderStep5Confirm(body, state, refresh) {
  if (wiz.kind === 'holdings') renderStep5Holdings(body, state, refresh);
  else renderStep5Dividend(body, state, refresh);
}

// --- shared foreign-currency rate handling ---
// A missing rate stays null (never silently 1) so a $2,000 holding can't be stored as ¥2,000.
// Rates are prefilled from the live FX quote when the local server can reach it.
function ensureRatesRequested(currencies, body, state, refresh) {
  const missing = currencies.filter((c) => wiz.rates[c] == null && !wiz.ratesTried.includes(c));
  if (missing.length === 0) return;
  wiz.ratesTried.push(...missing);
  fetchFxRates(missing).then((rates) => {
    let changed = false;
    for (const [c, rate] of Object.entries(rates)) {
      if (rate != null && wiz.rates[c] == null) { wiz.rates[c] = rate; changed = true; }
    }
    if (changed && wiz.step === 5) rerender(body, state, refresh);
  });
}

function missingRateCurrencies(currencies) {
  return currencies.filter((c) => !(wiz.rates[c] > 0));
}

function appendRateInputs(card, currencies, kindLabel, onChange) {
  if (currencies.length === 0) return;
  const rateGrid = el('div', { class: 'mapping-grid' });
  for (const c of currencies) {
    const known = wiz.rates[c] != null;
    const input = el('input', {
      type: 'number',
      step: '0.0001',
      value: known ? String(wiz.rates[c]) : '',
      placeholder: known ? '' : '自動取得できませんでした。手入力してください（例: 150）',
    });
    input.addEventListener('input', () => {
      const parsed = parseFloat(input.value);
      wiz.rates[c] = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      onChange();
    });
    rateGrid.appendChild(el('label', {}, `${c} → JPY レート`));
    rateGrid.appendChild(input);
  }
  card.appendChild(el('p', { class: 'hint' },
    `外貨建ての${kindLabel}があります。円換算に使う為替レートを確認してください（取得できた場合は現在のレートを自動入力しています）。`
  ));
  card.appendChild(rateGrid);
}

function renderStep5Holdings(body, state, refresh) {
  renderDetectionSummary(body, state, refresh);
  const { items, skipped } = computeHoldingItems();
  const currencies = [...new Set(items.map((it) => it.currency).filter((c) => c !== 'JPY'))];
  ensureRatesRequested(currencies, body, state, refresh);

  const dateInput = el('input', { type: 'date', value: wiz.date });
  dateInput.addEventListener('change', () => { wiz.date = dateInput.value; });

  const card = el('div', { class: 'card section-gap' }, [
    el('h2', {}, '内容の確認'),
    el('div', { class: 'form-row' }, [el('label', {}, '取込日（基準日）'), dateInput]),
    el('p', { class: 'hint' }, `取込対象: ${items.length}件 ${skipped ? `（金額が読み取れず除外: ${skipped}件）` : ''}`),
  ]);

  appendRateInputs(card, currencies, '銘柄', () => renderTotal());

  const totalEl = el('div', { class: 'stat-value section-gap' });
  function renderTotal() {
    if (missingRateCurrencies(currencies).length) {
      totalEl.textContent = '為替レート入力待ち';
      return;
    }
    const total = items.reduce((sum, it) => sum + it.value * (it.currency === 'JPY' ? 1 : wiz.rates[it.currency]), 0);
    totalEl.textContent = formatJPY(total);
  }
  renderTotal();
  card.appendChild(el('div', { class: 'stat-label' }, '合計評価額（この口座）'));
  card.appendChild(totalEl);
  body.appendChild(card);

  body.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, `銘柄一覧（${items.length}件）`),
    el('div', { class: 'preview-table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '銘柄名'), el('th', {}, '資産クラス'), el('th', { class: 'num' }, '数量'), el('th', { class: 'num' }, '評価額')])),
      el('tbody', {}, items.map((it) => el('tr', {}, [
        el('td', {}, it.name),
        el('td', {}, it.assetClass || '-'),
        el('td', { class: 'num' }, it.quantity != null && !Number.isNaN(it.quantity) ? formatNumber(it.quantity, 4) : '-'),
        el('td', { class: 'num' }, formatMoney(it.value, it.currency)),
      ]))),
    ])),
  ]));

  body.appendChild(el('div', { class: 'actions-row' }, [
    backButton(body, state, refresh, 4),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        if (!wiz.date) { showToast('日付を入力してください', 'error'); return; }
        const unset = missingRateCurrencies(currencies);
        if (unset.length) { showToast(`${unset.join('・')} の為替レートを入力してください`, 'error'); return; }
        const total = items.reduce((sum, it) => sum + it.value * (it.currency === 'JPY' ? 1 : wiz.rates[it.currency]), 0);
        const normalizedItems = items.map((it) => ({
          ...it,
          value: it.currency === 'JPY' ? it.value : it.value * wiz.rates[it.currency],
          fxRate: it.currency === 'JPY' ? 1 : wiz.rates[it.currency],
          originalValue: it.value,
        }));
        const snapshot = {
          id: `${wiz.brokerId}__${wiz.date}`,
          brokerId: wiz.brokerId,
          date: wiz.date,
          total,
          items: normalizedItems,
          importedAt: new Date().toISOString(),
        };
        await DB.saveSnapshot(snapshot);

        // Only a hand-made mapping is worth remembering; auto-detection re-reads the layout
        // every time, and saving its empty mapping would wipe a previously saved one.
        if (!wiz.autoDetected) {
          const broker = state.brokers.find((b) => b.id === wiz.brokerId);
          const savedMapping = {};
          for (const [field, idx] of Object.entries(wiz.mapping)) {
            savedMapping[field] = idx != null ? wiz.headers[idx] : null;
          }
          await DB.saveBroker({ ...broker, mapping: savedMapping });
        }

        // if the CSV had a code column, auto-register a guessed ticker for current-price lookup
        const guessed = normalizedItems
          .filter((it) => it.code)
          .map((it) => ({ name: it.name, code: guessYahooTicker(it.code, it.currency) }));
        if (guessed.length) await ensureTickersRegistered(guessed);

        showToast('取り込みました');
        wiz = freshWizard(wiz.kind);
        await refresh();
      },
    }, '保存する'),
  ]));
}

function renderStep5Dividend(body, state, refresh) {
  renderDetectionSummary(body, state, refresh);
  const { items, skipped } = computeDividendItems();
  const currencies = [...new Set(items.map((it) => it.currency).filter((c) => c !== 'JPY'))];
  ensureRatesRequested(currencies, body, state, refresh);

  const card = el('div', { class: 'card section-gap' }, [
    el('h2', {}, '内容の確認'),
    el('p', { class: 'hint' }, `取込対象: ${items.length}件 ${skipped ? `（日付・金額が読み取れず除外: ${skipped}件）` : ''} / 同じ内容（口座・日付・銘柄名・金額）がすでに登録済みの行は自動的にスキップされます。`),
  ]);

  appendRateInputs(card, currencies, '配当', () => renderTotal());

  const totalEl = el('div', { class: 'stat-value section-gap' });
  function renderTotal() {
    if (missingRateCurrencies(currencies).length) {
      totalEl.textContent = '為替レート入力待ち';
      return;
    }
    const total = items.reduce((sum, it) => sum + it.amount * (it.currency === 'JPY' ? 1 : wiz.rates[it.currency]), 0);
    totalEl.textContent = formatJPY(total);
  }
  renderTotal();
  card.appendChild(el('div', { class: 'stat-label' }, '合計配当額（この口座・今回の取込分）'));
  card.appendChild(totalEl);
  body.appendChild(card);

  const sortedItems = [...items].sort((a, b) => a.date.localeCompare(b.date));
  body.appendChild(el('div', { class: 'card section-gap' }, [
    el('h2', {}, `配当明細一覧（${items.length}件）`),
    el('div', { class: 'preview-table-wrap' }, el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, '支払日'), el('th', {}, '銘柄名'), el('th', { class: 'num' }, '金額')])),
      el('tbody', {}, sortedItems.map((it) => el('tr', {}, [
        el('td', {}, it.date),
        el('td', {}, it.name),
        el('td', { class: 'num' }, formatMoney(it.amount, it.currency)),
      ]))),
    ])),
  ]));

  body.appendChild(el('div', { class: 'actions-row' }, [
    backButton(body, state, refresh, 4),
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        const unset = missingRateCurrencies(currencies);
        if (unset.length) { showToast(`${unset.join('・')} の為替レートを入力してください`, 'error'); return; }
        const converted = items.map((it) => ({
          ...it,
          amount: it.currency === 'JPY' ? it.amount : it.amount * wiz.rates[it.currency],
          originalAmount: it.amount,
        }));
        const existingKeys = new Set(state.dividends.map((d) => `${d.brokerId}|${d.date}|${d.name}|${Math.round(d.amount)}`));
        let added = 0;
        let duplicates = 0;
        for (const it of converted) {
          const key = `${wiz.brokerId}|${it.date}|${it.name}|${Math.round(it.amount)}`;
          if (existingKeys.has(key)) { duplicates++; continue; }
          await DB.saveDividend({
            id: uid(),
            brokerId: wiz.brokerId,
            date: it.date,
            name: it.name,
            amount: it.amount,
            currency: it.currency,
            originalAmount: it.originalAmount,
            importedAt: new Date().toISOString(),
          });
          existingKeys.add(key);
          added++;
        }

        if (!wiz.autoDetected) {
          const broker = state.brokers.find((b) => b.id === wiz.brokerId);
          const savedMapping = {};
          for (const [field, idx] of Object.entries(wiz.mapping)) {
            savedMapping[field] = idx != null ? wiz.headers[idx] : null;
          }
          await DB.saveBroker({ ...broker, dividendMapping: savedMapping });
        }

        showToast(`取り込みました（${added}件追加${duplicates ? ` / 重複${duplicates}件をスキップ` : ''}）`);
        wiz = freshWizard(wiz.kind);
        await refresh();
      },
    }, '保存する'),
  ]));
}

function backButton(body, state, refresh, targetStep) {
  return el('button', { class: 'btn', onclick: () => { wiz.step = targetStep; rerender(body, state, refresh); } }, '← 戻る');
}
