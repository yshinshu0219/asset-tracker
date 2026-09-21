// One request layer for both back ends:
//   - local  : the Python server on this PC (relative /api/... routes)
//   - cloud  : the Google Apps Script web app (single POST endpoint, password in the body)
// Every call resolves to a plain object. Success: { ok: true, ...payload }.
// Failure: { ok: false, error: 'offline' | 'unauthorized' | 'locked' | 'outdated-server' | 'http-NNN' | string }.

const CONFIG_KEY = 'assetTrackerCloud';

export function getCloudConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    return cfg && cfg.url ? cfg : null;
  } catch (e) {
    return null;
  }
}

export function setCloudConfig(cfg) {
  if (cfg && cfg.url) localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: cfg.url.trim(), password: cfg.password || '' }));
  else localStorage.removeItem(CONFIG_KEY);
}

export function isCloudMode() {
  return !!getCloudConfig();
}

export async function api(action, params = {}) {
  const cfg = getCloudConfig();
  return cfg ? cloudRequest(cfg, action, params) : localRequest(action, params);
}

// Fire-and-forget save used when the page is closing (no response expected).
export function beaconSetData(data) {
  const cfg = getCloudConfig();
  const body = cfg
    ? JSON.stringify({ token: cfg.password, action: 'setData', params: { data } })
    : JSON.stringify(data);
  const url = cfg ? cfg.url : '/api/data';
  // text/plain keeps this a "simple" request, which is what the cloud endpoint accepts
  navigator.sendBeacon(url, new Blob([body], { type: cfg ? 'text/plain' : 'application/json' }));
}

// ---- cloud ----------------------------------------------------------------------------
async function cloudRequest(cfg, action, params) {
  let res;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script web apps can't answer
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.password, action, params }),
      redirect: 'follow',
    });
  } catch (e) {
    return { ok: false, error: 'offline' };
  }
  if (!res.ok) return { ok: false, error: 'http-' + res.status };
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, error: 'bad-response' }; // e.g. an HTML error page — usually a wrong URL
  }
  if (!body || body.ok !== true) return { ok: false, error: (body && body.error) || 'unknown', message: body && body.message };
  return body;
}

// ---- local PC server ------------------------------------------------------------------
async function localRequest(action, params) {
  const qs = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  let path;
  let init;
  switch (action) {
    case 'ping':
    case 'info':
      path = '/api/info'; break;
    case 'getData':
      path = '/api/data'; break;
    case 'setData':
      path = '/api/data';
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params.data) };
      break;
    case 'quote':
      path = '/api/quote?' + qs({ codes: (params.codes || []).join(',') }); break;
    case 'daily':
      path = '/api/daily?' + qs({ codes: (params.codes || []).join(','), range: params.range || '2y' }); break;
    case 'history':
      path = '/api/history?' + qs({ code: params.code || '' }); break;
    case 'dividends':
      path = '/api/dividends?' + qs({ codes: (params.codes || []).join(',') }); break;
    case 'tickers':
      path = '/api/tickers';
      init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers: params.tickers || [] }) };
      break;
    default:
      return { ok: false, error: 'unknown action' };
  }
  let res;
  try {
    res = await fetch(path, { cache: 'no-store', ...(init || {}) });
  } catch (e) {
    return { ok: false, error: 'offline' };
  }
  if (res.status === 404) return { ok: false, error: 'outdated-server' };
  if (!res.ok) return { ok: false, error: 'http-' + res.status };
  const body = await res.json().catch(() => ({}));
  if (action === 'getData') return { ok: true, data: body };
  return { ok: true, ...body };
}

// Human-readable explanation for an { ok:false } result, used by several screens.
export function describeApiError(error) {
  switch (error) {
    case 'offline':
      return isCloudMode()
        ? 'クラウドに接続できません。インターネット接続と「設定・スマホ」の接続先URLを確認してください。'
        : '「起動.bat」を実行してからアプリを開くと、株価・配当データを取得できます。';
    case 'outdated-server':
      return '起動中のサーバーが古いため取得できません。黒い画面を閉じてから「起動.bat」をもう一度実行してください。';
    case 'unauthorized':
      return 'クラウドのパスワードが一致しません。「設定・スマホ」で確認してください。';
    case 'locked':
      return 'パスワードの失敗が続いたため一時的にロックされています。15分ほど待ってからやり直してください。';
    case 'bad-response':
      return '接続先URLが正しくないようです（Apps Scriptの「ウェブアプリのURL」を貼り付けてください）。';
    default:
      return `取得に失敗しました（${error}）。`;
  }
}
