import type { SalaryPeriod } from './constants.js';

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
}

const HOURS_PER: Record<SalaryPeriod, number> = {
  hour: 1,
  day: 8,
  week: 40,
  month: 173.33,
  year: 2080,
};

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/₱|\bphp\b|\bpesos?\b/i, 'PHP'],
  [/€|\beur\b|\beuros?\b/i, 'EUR'],
  [/£|\bgbp\b/i, 'GBP'],
  [/\bcad\b|c\$/i, 'CAD'],
  [/\baud\b|a\$/i, 'AUD'],
  [/\bsgd\b|s\$/i, 'SGD'],
  [/\binr\b|₹/i, 'INR'],
  [/\$|\busd\b|\bdollars?\b/i, 'USD'],
];

/**
 * Approximate conversion to USD. These are coarse defaults for eligibility screening only;
 * PHP uses the user's configured `php_per_usd` instead.
 */
const USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  SGD: 0.74,
  INR: 0.012,
};

function parseAmount(raw: string): number | null {
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k|m)?/i);
  if (!m || !m[1]) return null;
  let n = parseFloat(m[1]);
  const suffix = m[2]?.toLowerCase();
  if (suffix === 'k') n *= 1000;
  if (suffix === 'm') n *= 1_000_000;
  return Number.isFinite(n) ? n : null;
}

export function detectSalaryPeriod(text: string): SalaryPeriod | null {
  const t = text.toLowerCase();
  if (/(per|an|\/|a)\s*(hour|hr)\b|hourly|\/h\b|p\/h/.test(t)) return 'hour';
  if (/(per|a|\/)\s*day\b|daily/.test(t)) return 'day';
  if (/(per|a|\/)\s*week\b|weekly/.test(t)) return 'week';
  if (/(per|a|\/)\s*(month|mo)\b|monthly|\/mo\b/.test(t)) return 'month';
  if (/(per|a|\/)\s*(year|yr|annum)\b|annual|yearly|\bpa\b|p\.a\./.test(t)) return 'year';
  return null;
}

export function detectCurrency(text: string): string | null {
  for (const [re, code] of CURRENCY_SYMBOLS) if (re.test(text)) return code;
  return null;
}

/** Parses free-text salaries such as "$60k - $80k / year", "₱20,000/month" or "USD 6-8 per hour". */
export function parseSalary(text: string | null | undefined): ParsedSalary {
  const empty: ParsedSalary = { min: null, max: null, currency: null, period: null };
  if (!text) return empty;
  const t = text.trim();
  if (!/\d/.test(t)) return empty;
  const amounts = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/gi)]
    .map((m) => parseAmount(m[0]))
    .filter((n): n is number => n !== null && n > 0);
  if (!amounts.length) return empty;
  const currency = detectCurrency(t);
  let period = detectSalaryPeriod(t);
  const min = Math.min(...amounts.slice(0, 2));
  const max = Math.max(...amounts.slice(0, 2));
  if (!period) {
    // Infer from magnitude when unstated (USD-like currencies).
    if (currency === 'PHP') period = max >= 150_000 ? 'year' : max >= 2_000 ? 'month' : max >= 300 ? 'day' : 'hour';
    else period = max >= 15_000 ? 'year' : max >= 1_000 ? 'month' : max >= 150 ? 'day' : 'hour';
  }
  return { min, max, currency, period };
}

/** Converts an amount to USD per hour; returns null when currency is unknown. */
export function toHourlyUsd(
  amount: number,
  currency: string | null,
  period: SalaryPeriod | null,
  phpPerUsd = 58,
): number | null {
  if (!currency || !period) return null;
  const code = currency.toUpperCase();
  const usd = code === 'PHP' ? amount / phpPerUsd : USD_PER_UNIT[code] !== undefined ? amount * USD_PER_UNIT[code]! : null;
  if (usd === null) return null;
  return usd / HOURS_PER[period];
}

export function convertSalary(
  amount: number,
  from: { currency: string; period: SalaryPeriod },
  to: { currency: string; period: SalaryPeriod },
  phpPerUsd = 58,
): number | null {
  const hourlyUsd = toHourlyUsd(amount, from.currency, from.period, phpPerUsd);
  if (hourlyUsd === null) return null;
  const target = to.currency.toUpperCase();
  const perUnit = target === 'PHP' ? 1 / phpPerUsd : USD_PER_UNIT[target];
  if (!perUnit) return null;
  return (hourlyUsd * HOURS_PER[to.period]) / perUnit;
}

export function formatSalary(
  s: { salary_min: number | null; salary_max: number | null; salary_currency: string | null; salary_period: SalaryPeriod | null; salary_text?: string | null },
): string {
  if (s.salary_min === null && s.salary_max === null) return s.salary_text || 'Not disclosed';
  const cur = s.salary_currency ?? '';
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n * 100) / 100));
  const range =
    s.salary_min !== null && s.salary_max !== null && s.salary_min !== s.salary_max
      ? `${fmt(s.salary_min)}–${fmt(s.salary_max)}`
      : fmt((s.salary_max ?? s.salary_min)!);
  return `${cur} ${range}${s.salary_period ? ` / ${s.salary_period}` : ''}`.trim();
}
