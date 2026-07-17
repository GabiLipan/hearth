export const CURRENCIES = [
  { code: 'GBP', label: 'British Pound (£)', locale: 'en-GB' },
  { code: 'USD', label: 'US Dollar ($)', locale: 'en-US' },
  { code: 'EUR', label: 'Euro (€)', locale: 'en-IE' },
  { code: 'AUD', label: 'Australian Dollar ($)', locale: 'en-AU' },
  { code: 'CAD', label: 'Canadian Dollar ($)', locale: 'en-CA' },
  { code: 'NZD', label: 'NZ Dollar ($)', locale: 'en-NZ' },
  { code: 'ILS', label: 'Israeli Shekel (₪)', locale: 'he-IL' },
  { code: 'CHF', label: 'Swiss Franc', locale: 'de-CH' },
] as const

export type CurrencyCode = (typeof CURRENCIES)[number]['code']

function localeFor(code: string) {
  return CURRENCIES.find((c) => c.code === code)?.locale ?? 'en-GB'
}

/** Format integer minor units as currency. */
export function fmtMoney(
  minor: number,
  currency: string,
  opts: { sign?: boolean; compact?: boolean; hideDecimals?: boolean } = {},
) {
  const value = minor / 100
  const abs = Math.abs(value)
  const hideDecimals = opts.hideDecimals ?? Number.isInteger(abs)
  const str = new Intl.NumberFormat(localeFor(currency), {
    style: 'currency',
    currency,
    notation: opts.compact && abs >= 10000 ? 'compact' : 'standard',
    minimumFractionDigits: hideDecimals ? 0 : 2,
    maximumFractionDigits: hideDecimals ? 0 : 2,
  }).format(abs)
  if (opts.sign) return (minor < 0 ? '−' : '+') + str
  return minor < 0 ? '−' + str : str
}

export function currencySymbol(currency: string) {
  const parts = new Intl.NumberFormat(localeFor(currency), {
    style: 'currency',
    currency,
  }).formatToParts(0)
  return parts.find((p) => p.type === 'currency')?.value ?? currency
}

/** Parse a user-typed amount ("12.50", "1,200") into minor units, or null. */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}
