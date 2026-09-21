// Known brokerage institutions, used two ways:
// 1. To seed the initial set of accounts on first launch (see defaultBrokers.js).
// 2. As a convenience dropdown when adding a new account — picking one auto-fills the color,
//    login URL, and CSV-download instructions, while the account's own name stays free text.
// This is what makes "one account per institution" a soft default rather than a hard limit:
// nothing stops the user from adding a second "SBI証券" account for a different family member.
export const INSTITUTION_PRESETS = [
  {
    name: '楽天証券',
    color: '#bf0000',
    loginUrl: 'https://www.rakuten-sec.co.jp/',
    instructions:
      'ログイン後「口座管理」タブ →「資産残高・保有商品」→「保有商品一覧」を開き、\n' +
      'ページ内の「CSVで保存」からダウンロードしてください。',
  },
  {
    name: 'SBI証券',
    color: '#00a0e9',
    loginUrl: 'https://www.sbisec.co.jp/',
    instructions:
      'ログイン後「口座管理」→「保有証券」(ポートフォリオ) を開き、\n' +
      '画面下部/右上の「CSVダウンロード」から保存してください。\n' +
      '外国株式を保有している場合は「口座（外貨建）」からも別途ダウンロードが必要です。',
  },
  {
    name: '大和証券',
    color: '#004098',
    loginUrl: 'https://www.daiwa.jp/onlinetrade/',
    instructions:
      'ログイン後「資産管理」→残高サマリー/保有証券一覧の画面を開き、\n' +
      'CSVダウンロード機能から保存してください。\n' +
      '見当たらない場合は「取引履歴」内のCSVダウンロードをご利用ください。',
  },
  {
    name: 'SMBC日興証券',
    color: '#00913a',
    loginUrl: 'https://trade.smbcnikko.co.jp/',
    instructions:
      '日興イージートレードにログイン後「口座残高」→「保有証券」を開き、保有証券一覧を表示します。\n' +
      '一覧画面にCSVダウンロードが見当たらない場合は「お取引履歴」→「お取引履歴」からCSV形式でダウンロードしてください。',
  },
  {
    name: 'マネックス証券',
    color: '#003897',
    loginUrl: 'https://www.monex.co.jp/',
    instructions:
      'ログイン後「保有残高・口座管理」からポートフォリオ（保有証券一覧）画面を開き、\n' +
      'CSVダウンロードから保存してください。\n' +
      '取引履歴からのダウンロードは「保有残高・口座管理」→「取引履歴・損益」→「全取引履歴」から可能です。',
  },
];
