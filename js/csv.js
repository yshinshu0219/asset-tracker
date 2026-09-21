// CSV reading helpers: encoding detection (Shift-JIS is common for JP brokerage exports) + parsing.

// Reads a File and returns decoded text, auto-detecting Shift_JIS / UTF-8 / UTF-16.
export async function readCsvFileAsText(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Encoding.js (loaded globally as `Encoding`) detects and converts Japanese encodings reliably.
  const detected = Encoding.detect(bytes) || 'UTF8';
  const unicodeArray = Encoding.convert(bytes, { to: 'UNICODE', from: detected, type: 'array' });
  return Encoding.codeToString(unicodeArray);
}

// Parses CSV text into a raw 2D array (no header assumption — brokerage exports often have
// preamble rows before the real header row).
export function parseCsvRaw(text) {
  const result = Papa.parse(text.trim(), { skipEmptyLines: true });
  if (result.errors && result.errors.length) {
    console.warn('CSV parse warnings:', result.errors);
  }
  return result.data;
}

// Strict numeric check (the whole cleaned cell must be a number) — used only for header-row
// guessing, where a lenient "starts with a digit" check would misfire on dates like 2026/09/10.
function looksFullyNumeric(v) {
  if (v == null) return false;
  const cleaned = String(v)
    .replace(/[,，]/g, '')
    .replace(/[¥￥$]/g, '')
    .replace(/(円|株|口|株式|口座)$/g, '')
    .trim();
  return cleaned !== '' && /^-?\d+(\.\d+)?$/.test(cleaned);
}

function looksLikeDate(v) {
  if (v == null) return false;
  return /^\d{4}[\/\-年.]\d{1,2}[\/\-月.]\d{1,2}/.test(String(v).trim());
}

function looksLikeData(v) {
  return looksFullyNumeric(v) || looksLikeDate(v);
}

// Best-effort guess at which row is the header: a row with several columns, none of them
// numeric/date-like, immediately followed by a row containing at least one numeric or date
// value. Brokerage exports often have 2-cell preamble/metadata lines above the real table
// (skipped via the column-count check), and dividend CSVs often have only one truly numeric
// column (amount) alongside a date and a text name, so we only require one data-like cell
// rather than a majority.
export function guessHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length - 1, 15); i++) {
    const row = rows[i];
    const next = rows[i + 1];
    if (!row || !next || row.length < 3) continue;
    const rowDataCount = row.filter(looksLikeData).length;
    const nextDataCount = next.filter(looksLikeData).length;
    if (rowDataCount === 0 && nextDataCount >= 1) return i;
  }
  return 0;
}

// Parses a Japanese-formatted number string: strips commas, yen signs, unit suffixes, spaces.
export function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (value == null) return NaN;
  const cleaned = String(value)
    .replace(/[,，]/g, '')
    .replace(/[¥￥$]/g, '')
    .replace(/(円|株|口|株式|口座)$/g, '')
    .trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '--') return NaN;
  return parseFloat(cleaned);
}

// Parses common Japanese/brokerage date formats (2026/09/10, 2026-09-10, 2026年9月10日, with or
// without a trailing time) into an ISO "YYYY-MM-DD" string. Returns null if unrecognized.
export function parseDateToISO(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    const mm = String(mo).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  // Compact YYYYMMDD, with no separators — some brokerage exports use this.
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const [, y, mo, d] = compact;
    return `${y}-${mo}-${d}`;
  }
  return null;
}
