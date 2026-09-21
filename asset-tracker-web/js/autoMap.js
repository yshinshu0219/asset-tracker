// Automatic CSV structure detection.
//
// Japanese brokerage exports are messier than a single table: one file often contains several
// sections ("株式（現物／特定預り）", then "投資信託（金額／特定預り）", …), each with its OWN
// header row and its own column layout, plus caption lines and 合計 rows mixed in. Reading such
// a file with one header row makes every later section land in the wrong columns, which is why
// totals came out wrong. This module finds each section, maps its columns by name, and lets the
// import wizard skip the manual mapping steps entirely.

// Header keywords per field, best match first. `avoid` keeps a field from stealing a column that
// obviously belongs to another one (e.g. 銘柄コード must not be picked up as the 銘柄名).
const FIELD_KEYWORDS = {
  holdings: {
    name: {
      keywords: ['銘柄名', 'ファンド名', '投資信託名', '商品名', '銘柄・コース名', '名称', '銘柄'],
      // Only a column that IS a code is off-limits. SBI writes "銘柄（コード）" for a column
      // holding "トヨタ自動車(7203)" — that one is the name column, code included.
      avoidExact: ['コード', '銘柄コード', '証券コード', 'ファンドコード', 'ティッカー', 'シンボル'],
      avoid: ['数量', '単価', '金額', '通貨', '区分'],
    },
    value: {
      keywords: ['時価評価額', '評価額', '評価金額', '時価残高', '残高金額', '時価'],
      avoid: ['損益', '率', '取得', '前日'],
    },
    quantity: {
      keywords: ['保有数量', '保有口数', '残高数量', '数量', '株数', '口数'],
      avoid: ['単価', '金額', '率', '額'],
    },
    unitPrice: {
      // 楽天証券 writes 平均取得価額 / 平均取得価格 (with a separate "[単位]" column after it),
      // SBI writes 取得単価. Anything prefixed 平均 is per-unit by definition.
      keywords: ['平均取得単価', '平均取得価額', '平均取得価格', '取得単価', '買付単価', '平均取得', '取得価格'],
      avoid: ['金額', '評価', '損益', '合計'],
    },
    // A TOTAL acquisition cost column (no 平均 / 単価 in the name). Used to derive the unit
    // price when the CSV has no per-unit column at all.
    costTotal: {
      keywords: ['取得金額', '取得価額', '取得額', '買付金額', '取得コスト'],
      avoid: ['平均', '単価', '評価', '損益', '1口', '1株'],
    },
    currentPrice: {
      keywords: ['現在値', '基準価額', '時価単価'],
      avoid: ['損益', '率', '評価額'],
    },
    code: {
      keywords: ['銘柄コード', '証券コード', 'ティッカー', 'シンボル', 'コード'],
      avoid: ['ファンドコード'],
    },
    currency: {
      keywords: ['決済通貨', '通貨'],
      avoid: [],
    },
    assetClass: {
      keywords: ['商品区分', '資産クラス', '種別', 'カテゴリ', '預り区分', '口座区分'],
      avoid: [],
    },
  },
  dividend: {
    name: {
      keywords: ['銘柄名', 'ファンド名', '商品名', '名称', '銘柄'],
      avoid: ['コード', 'code', '金額', '数量', '日'],
    },
    date: {
      keywords: ['支払日', '入金日', '受渡日', '支払確定日', '配当支払日', '年月日', '取引日', '日付'],
      avoid: ['基準日'],
    },
    amount: {
      keywords: ['受取金額', '税引後金額', '手取金額', '配当金額', '分配金額', '受取額', '金額'],
      avoid: ['税額', '単価', '税引前'],
    },
    currency: {
      keywords: ['決済通貨', '通貨'],
      avoid: [],
    },
  },
};

const REQUIRED_FIELDS = {
  holdings: ['name'],
  dividend: ['name', 'date', 'amount'],
};

const SUMMARY_ROW_NAMES = ['合計', '小計', '総合計', '計', '総計', 'total'];

// Parentheses are kept: "銘柄コード" and "銘柄（コード）" mean different things, and folding
// them together would make the combined name+code column look like a pure code column.
function normalizeHeader(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

function isFullyNumeric(value) {
  const cleaned = String(value ?? '').replace(/[,，¥￥$%]/g, '').trim();
  return cleaned !== '' && /^-?\d+(\.\d+)?$/.test(cleaned);
}

function matchColumn(headers, spec, used) {
  const avoid = (spec.avoid || []).map(normalizeHeader);
  const avoidExact = (spec.avoidExact || []).map(normalizeHeader);
  const candidates = headers
    .map((h, i) => ({ i, h: normalizeHeader(h) }))
    .filter(({ i, h }) => !used.has(i) && h !== ''
      && !avoid.some((a) => h.includes(a))
      && !avoidExact.includes(h));

  for (const keyword of spec.keywords) {
    const kw = normalizeHeader(keyword);
    const exact = candidates.find((c) => c.h === kw);
    if (exact) return exact.i;
  }
  for (const keyword of spec.keywords) {
    const kw = normalizeHeader(keyword);
    const partial = candidates.find((c) => c.h.includes(kw));
    if (partial) return partial.i;
  }
  return null;
}

export function autoMapHeaders(headers, kind) {
  const dict = FIELD_KEYWORDS[kind];
  const mapping = {};
  const used = new Set();
  for (const [field, spec] of Object.entries(dict)) {
    const index = matchColumn(headers, spec, used);
    mapping[field] = index;
    if (index != null) used.add(index);
  }
  return mapping;
}

function looksLikeHeaderRow(row, kind) {
  const cells = row.filter((c) => String(c ?? '').trim() !== '');
  if (cells.length < 2) return false;
  if (row.some(isFullyNumeric)) return false; // a data row, not a header
  const dict = FIELD_KEYWORDS[kind];
  const allKeywords = Object.values(dict).flatMap((spec) => spec.keywords.map(normalizeHeader));
  const hits = cells.filter((c) => {
    const h = normalizeHeader(c);
    return allKeywords.some((kw) => h.includes(kw));
  });
  return hits.length >= 2;
}

// "トヨタ自動車(7203)" → { name: 'トヨタ自動車', code: '7203' }. Several brokers pack the code
// into the name cell instead of giving it its own column.
export function splitNameAndCode(rawName) {
  const text = String(rawName ?? '').trim();
  const m = text.match(/^(.*?)[（(]\s*([A-Za-z0-9.\-]{1,12})\s*[）)]\s*$/);
  if (!m || !m[1].trim()) return { name: text, code: '' };
  return { name: m[1].trim(), code: m[2].trim() };
}

export function isSummaryRow(name) {
  const n = normalizeHeader(name);
  return n === '' || SUMMARY_ROW_NAMES.some((s) => n === normalizeHeader(s));
}

// Splits raw CSV rows into one entry per header block found in the file.
export function detectSections(rows, kind) {
  const sections = [];
  let current = null;
  let lastCaption = '';

  for (const row of rows) {
    const nonEmpty = (row || []).filter((c) => String(c ?? '').trim() !== '');
    if (nonEmpty.length === 0) continue;

    if (looksLikeHeaderRow(row, kind)) {
      const headers = row.map((h, i) => (h && String(h).trim()) || `列${i + 1}`);
      current = { title: lastCaption, headers, dataRows: [], mapping: autoMapHeaders(headers, kind) };
      sections.push(current);
      continue;
    }
    if (nonEmpty.length === 1) {         // section caption such as "投資信託（金額/特定預り）"
      lastCaption = String(nonEmpty[0]).trim();
      continue;
    }
    if (!current) continue;              // preamble above the first header
    current.dataRows.push(row);
  }

  for (const section of sections) section.isFund = looksLikeFundSection(section);
  return sections.filter((s) => s.dataRows.length > 0 && sectionIsUsable(s, kind));
}

// 投資信託 rows quote 口数 against prices that are per 10,000 口, so quantity × price is 10,000x
// too large unless divided. The caption ("投資信託…"), a 口数 column, or a 基準価額 column all
// mark a fund section. The per-row ratio check in the importer has the final say.
function looksLikeFundSection(section) {
  const { mapping, headers, title } = section;
  const t = normalizeHeader(title || '');
  if (t.includes('投資信託') || t.includes('投信') || t.includes('ファンド')) return true;
  const qtyHeader = mapping.quantity != null ? normalizeHeader(headers[mapping.quantity]) : '';
  const priceHeaders = [mapping.currentPrice, mapping.unitPrice]
    .filter((i) => i != null).map((i) => normalizeHeader(headers[i]));
  return qtyHeader.includes('口') || priceHeaders.some((h) => h.includes('基準価額'));
}

function sectionIsUsable(section, kind) {
  return REQUIRED_FIELDS[kind].every((field) => section.mapping[field] != null);
}

// True when every section needed to read the file was recognised, i.e. the wizard can skip the
// manual header/mapping steps.
export function detectionIsComplete(sections, kind) {
  if (sections.length === 0) return false;
  return sections.every((s) => sectionIsUsable(s, kind));
}

export function describeSection(section, kind) {
  const labels = { name: '銘柄名', value: '評価額', quantity: '数量', unitPrice: '取得単価', costTotal: '取得金額', currentPrice: '現在値', code: 'コード', currency: '通貨', assetClass: '区分', date: '支払日', amount: '金額' };
  const parts = Object.entries(section.mapping)
    .filter(([, idx]) => idx != null)
    .map(([field, idx]) => `${labels[field] || field}=「${section.headers[idx]}」`);
  // Call out a missing acquisition price loudly: without it 評価損益 and 取得利回り stay blank,
  // and the user needs to know which header the file used so the dictionary can be extended.
  if (kind === 'holdings' && section.mapping.unitPrice == null && section.mapping.costTotal == null) {
    parts.push('取得単価=⚠ 未検出（列名: ' + section.headers.join('、') + '）');
  }
  if (section.isFund) parts.push('投資信託として処理');
  return parts.join(' / ');
}
