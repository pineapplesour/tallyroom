/**
 * Number formatting.
 *
 * The app does not assume a currency. It reads whatever the statement declares
 * and formats with Intl, so a dollar file shows $1,284.00 and a won file shows
 * ₩1,732,000 with no decimals - and neither one gets the other's conventions
 * bolted onto it.
 */

let currency = null;
let fractionDigits = 2;

/** Called after a file loads, with the currencies present in the data. */
export function setCurrency(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  currency = list.length === 1 ? list[0] : null;
  fractionDigits = ZERO_DECIMAL.has(currency) ? 0 : 2;
}

// Currencies conventionally written without a fractional part.
const ZERO_DECIMAL = new Set(["KRW", "JPY", "VND", "CLP", "ISK", "HUF", "TWD"]);

const nf = (opts) => new Intl.NumberFormat("en-US", currency
  ? { style: "currency", currency, ...opts }
  : { ...opts });

/** Full precision, for tables and tooltips. */
export function money(n) {
  const v = Number(n) || 0;
  try {
    return nf({ minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(v);
  } catch {
    return v.toLocaleString("en-US");
  }
}

/** Short form, for axis ticks and bar labels where space is tight.
 *  Below a thousand there is room for the whole number, so no decimals and no
 *  compact suffix; above it, one decimal of compact notation. */
export function compact(n) {
  const v = Number(n) || 0;
  try {
    return Math.abs(v) < 1000
      ? nf({ maximumFractionDigits: 0 }).format(v)
      : nf({ notation: "compact", maximumFractionDigits: 1 }).format(v);
  } catch {
    return v.toLocaleString("en-US");
  }
}

/** Plain number, no currency - counts, percentages, row totals. */
export const plain = (n) => (Number(n) || 0).toLocaleString("en-US");

export const currencyCode = () => currency;
