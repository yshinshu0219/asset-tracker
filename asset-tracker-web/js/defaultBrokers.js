import { uid } from './db.js';
import { INSTITUTION_PRESETS } from './institutionPresets.js';

const EMPTY_HOLDINGS_MAPPING = { name: null, quantity: null, unitPrice: null, value: null, currency: null, assetClass: null, code: null };
const EMPTY_DIVIDEND_MAPPING = { name: null, date: null, amount: null, currency: null };

// Seeds one account per known institution on first launch. These are just a starting point —
// each account (including these) can be freely renamed, and more accounts can be added for the
// same institution (e.g. a second "SBI証券" account for another family member).
export function buildDefaultBrokers() {
  return INSTITUTION_PRESETS.map((preset) => ({
    id: uid(),
    name: preset.name,
    institution: preset.name,
    color: preset.color,
    loginUrl: preset.loginUrl,
    instructions: preset.instructions,
    mapping: { ...EMPTY_HOLDINGS_MAPPING },
    dividendMapping: { ...EMPTY_DIVIDEND_MAPPING },
    headerRowHint: null,
  }));
}
