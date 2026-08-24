/**
 * The one number formatter for the whole product.
 *
 * Every rupiah value on every screen and in every export goes through this
 * module. No page formats money on its own, so the accounting convention is
 * fixed in one place:
 *
 *   - Indonesian separators: "." groups thousands, "," is the decimal mark.
 *   - Always exactly two decimals.
 *   - Zero renders as "0,00", never as blank, because the accounting team
 *     cross checks reports on the presence of the zero (spec section 10).
 *   - Input may be a number OR a decimal string. The API returns money as a
 *     string because the database column is NUMERIC(20,2), and parsing that
 *     into a JS float would lose precision on large values. Strings are
 *     therefore formatted by digit surgery, never by going through Number().
 *   - An UNPARSEABLE value renders as the marker below, never as a number.
 *     See UNPARSEABLE.
 */

/**
 * What a value that is not a number renders as.
 *
 * It used to render as "0,00", and that was the worst available answer: on a
 * report an auditor signs, a silent "Rp 0,00" standing in for a figure that
 * failed to arrive is indistinguishable from a real zero balance, so the error
 * is invisible and the total is wrong with nothing on the page admitting it.
 * Spec section 10 ranks a wrong number above a missing feature.
 *
 * A visible marker instead: the cell is obviously not a figure, the row does
 * not tie, and whoever reads it knows to go and look. Zero itself is
 * unaffected and still renders "0,00" (the accounting team cross checks on the
 * printed zero), because zero is parseable and this is not about zero.
 *
 * In development the formatter throws instead, so the bug is caught by whoever
 * introduced it rather than by a client reading a PDF.
 */
export const UNPARSEABLE = "tidak sah";

export interface MoneyFormatOptions {
  /** Number of decimals. Money is always 2; other quantities may differ. */
  decimals?: number;
  /**
   * Render negatives in accounting parentheses, "(1.250,00)", instead of with
   * a leading minus sign. Off by default; report templates that follow the
   * client's house style turn it on.
   */
  parenthesizeNegative?: boolean;
}

const GROUP_SEPARATOR = ".";
const DECIMAL_SEPARATOR = ",";

interface Decimal {
  negative: boolean;
  digits: string; // integer digits, no separators, no sign
  fraction: string; // fractional digits, no separators
}

function parseDecimal(input: number | string | null | undefined): Decimal | null {
  if (input === null || input === undefined) return { negative: false, digits: "0", fraction: "" };

  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    // Above 1e21 toFixed switches to exponential notation, which the decimal
    // grammar below deliberately rejects. A rupiah figure that large is a bug
    // upstream, and money that big should have arrived as a NUMERIC string.
    if (Math.abs(input) >= 1e21) return null;
    // toFixed(20) keeps far more precision than the two decimals money needs,
    // so the rounding below is the only rounding that happens.
    return parseDecimal(input.toFixed(20));
  }

  const raw = input.trim();
  if (raw === "") return { negative: false, digits: "0", fraction: "" };

  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) return null;

  const digits = (match[2] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const fraction = match[3] ?? "";
  const negative = match[1] === "-" && !(digits === "0" && /^0*$/.test(fraction));
  return { negative, digits, fraction };
}

/** Round a Decimal to `decimals` places, carrying into the integer digits. */
function roundDecimal(value: Decimal, decimals: number): Decimal {
  const fraction = value.fraction;
  if (fraction.length <= decimals) {
    return { ...value, fraction: fraction.padEnd(decimals, "0") };
  }

  const kept = fraction.slice(0, decimals);
  const roundUp = Number(fraction[decimals]) >= 5;
  if (!roundUp) return { ...value, fraction: kept };

  // Carry by adding 1 to the last kept position, using string addition so a
  // 20 digit rupiah value cannot drift through a float.
  const combined = value.digits + kept;
  const carried = addOne(combined);
  const fracLength = kept.length;
  const padded = carried.padStart(fracLength + 1, "0");
  return {
    negative: value.negative,
    digits: padded.slice(0, padded.length - fracLength).replace(/^0+(?=\d)/, "") || "0",
    fraction: fracLength === 0 ? "" : padded.slice(padded.length - fracLength),
  };
}

function addOne(digits: string): string {
  const out = digits.split("");
  let i = out.length - 1;
  for (;;) {
    if (i < 0) {
      out.unshift("1");
      break;
    }
    const next = Number(out[i]) + 1;
    if (next < 10) {
      out[i] = String(next);
      break;
    }
    out[i] = "0";
    i -= 1;
  }
  return out.join("");
}

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += GROUP_SEPARATOR;
    out += digits[i];
  }
  return out;
}

/**
 * True when the formatter should throw on an unparseable value rather than
 * render the marker. Production renders the marker, because a thrown error in
 * one table cell must not blank out the whole report the accountant needs; a
 * development or test build throws, because a bug caught at the keyboard is
 * cheaper than a bug caught at a client.
 *
 * Read at call time, not at module load, so a test can flip NODE_ENV.
 */
function throwOnUnparseable(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return (env?.NODE_ENV ?? "development") !== "production";
}

/**
 * Format a rupiah amount for display.
 *
 * Zero, null, undefined, and an empty string all render as "0,00" on purpose:
 * an accounting report never shows a blank where a figure belongs.
 *
 * A value that is not a number at all is a different case entirely and does
 * NOT render as a number. See UNPARSEABLE.
 */
export function formatMoney(
  value: number | string | null | undefined,
  options: MoneyFormatOptions = {},
): string {
  const decimals = options.decimals ?? 2;
  const parsed = parseDecimal(value);
  if (parsed === null) {
    if (throwOnUnparseable()) {
      throw new TypeError(
        `formatMoney: nilai tidak dapat dibaca sebagai angka: ${JSON.stringify(value)}`,
      );
    }
    return UNPARSEABLE;
  }
  const decimal = roundDecimal(parsed, decimals);

  const body =
    groupThousands(decimal.digits) +
    (decimals > 0 ? DECIMAL_SEPARATOR + decimal.fraction.padEnd(decimals, "0") : "");

  if (!decimal.negative) return body;
  return options.parenthesizeNegative ? `(${body})` : `-${body}`;
}

/** Money with the currency prefix, for a single figure outside a table. */
export function formatRupiah(
  value: number | string | null | undefined,
  options: MoneyFormatOptions = {},
): string {
  const formatted = formatMoney(value, options);
  // No "Rp" in front of the marker: "Rp tidak sah" reads like a currency
  // amount at a glance, which is the exact confusion the marker exists to end.
  if (formatted === UNPARSEABLE) return UNPARSEABLE;
  return formatted.startsWith("-") ? `-Rp ${formatted.slice(1)}` : `Rp ${formatted}`;
}

/** A whole count (jumlah mitra, jumlah dokumen). No decimals. */
export function formatCount(value: number | string | null | undefined): string {
  return formatMoney(value, { decimals: 0 });
}

/** A percentage, two decimals, with the sign glued on. */
export function formatPercent(
  value: number | string | null | undefined,
  options: MoneyFormatOptions = {},
): string {
  const formatted = formatMoney(value, { decimals: 2, ...options });
  if (formatted === UNPARSEABLE) return UNPARSEABLE;
  return `${formatted}%`;
}

/** ISO date (or Date) rendered as dd-mm-yyyy, the format on client forms. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

export const NAMA_BULAN = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

/** "Agustus 2026" from a periode (tahun, bulan) pair. */
export function formatPeriode(tahun: number, bulan: number): string {
  const nama = NAMA_BULAN[bulan - 1];
  return nama ? `${nama} ${tahun}` : String(tahun);
}
