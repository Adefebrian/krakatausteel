import { afterEach, describe, expect, test } from "bun:test";
import {
  formatCount,
  formatDate,
  formatMoney,
  formatPercent,
  formatPeriode,
  formatRate,
  formatRupiah,
  formatTotal,
  jumlahkanUang,
  parseRate,
  parseUang,
  uangKeInput,
  UNPARSEABLE,
} from "./money";

const realNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (realNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = realNodeEnv;
});

describe("formatMoney", () => {
  test("renders zero as 0,00, never as blank", () => {
    // Spec section 10: the accounting team cross checks on the zero being
    // printed, so an absent figure must never collapse to an empty cell.
    expect(formatMoney(0)).toBe("0,00");
    expect(formatMoney("0")).toBe("0,00");
    expect(formatMoney("0.00")).toBe("0,00");
    expect(formatMoney(null)).toBe("0,00");
    expect(formatMoney(undefined)).toBe("0,00");
    expect(formatMoney("")).toBe("0,00");
  });

  test("groups thousands with a dot and marks decimals with a comma", () => {
    expect(formatMoney(1000)).toBe("1.000,00");
    expect(formatMoney(999)).toBe("999,00");
    expect(formatMoney(1234567.89)).toBe("1.234.567,89");
    expect(formatMoney(12500000)).toBe("12.500.000,00");
    expect(formatMoney(1.5)).toBe("1,50");
  });

  test("formats a NUMERIC string without going through a float", () => {
    expect(formatMoney("1250000.00")).toBe("1.250.000,00");
    // 18 significant digits: a float would have lost the tail here.
    expect(formatMoney("123456789012345678.99")).toBe("123.456.789.012.345.678,99");
  });

  test("rounds half up and carries into the integer digits", () => {
    expect(formatMoney("0.005")).toBe("0,01");
    expect(formatMoney("9.999")).toBe("10,00");
    expect(formatMoney("999.999")).toBe("1.000,00");
    expect(formatMoney("1.004")).toBe("1,00");
  });

  test("renders negatives with a minus sign, or in accounting parentheses", () => {
    expect(formatMoney(-1500)).toBe("-1.500,00");
    expect(formatMoney(-1500, { parenthesizeNegative: true })).toBe("(1.500,00)");
    expect(formatMoney("-0.00")).toBe("0,00");
  });

  test("throws on an unparseable value outside production", () => {
    // A wrong number on a report an auditor signs is worse than a crash in
    // development, so the bug surfaces at the keyboard of whoever caused it.
    process.env.NODE_ENV = "development";
    expect(() => formatMoney(Number.NaN)).toThrow(TypeError);
    expect(() => formatMoney("bukan angka")).toThrow(/tidak dapat dibaca/);
    expect(() => formatMoney(1e21)).toThrow(TypeError);
    expect(() => formatMoney(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  test("renders a visible marker for an unparseable value in production, never a figure", () => {
    // The old behaviour returned "0,00" here. That is the worst possible
    // answer: a silent zero standing in for a real figure is indistinguishable
    // from a real zero balance, so the total is wrong and nothing on the page
    // says so. The marker is not a number and cannot be mistaken for one.
    process.env.NODE_ENV = "production";
    expect(formatMoney("bukan angka")).toBe(UNPARSEABLE);
    expect(formatMoney(Number.NaN)).toBe(UNPARSEABLE);
    expect(formatMoney("12,5")).toBe(UNPARSEABLE); // comma is not the input grammar
    expect(formatMoney("1.234.567,89")).toBe(UNPARSEABLE); // already formatted, not raw
    expect(formatMoney("bukan angka")).not.toBe("0,00");
    expect(formatMoney("bukan angka")).not.toContain("0");
  });

  test("the marker never wears a currency prefix or a percent sign", () => {
    process.env.NODE_ENV = "production";
    // "Rp tidak sah" or "tidak sah%" would read like a figure at a glance,
    // which is exactly the confusion the marker exists to end.
    expect(formatRupiah("bukan angka")).toBe(UNPARSEABLE);
    expect(formatPercent("bukan angka")).toBe(UNPARSEABLE);
    expect(formatCount("bukan angka")).toBe(UNPARSEABLE);
  });

  test("a real zero is untouched by any of that", () => {
    // Spec section 10 still holds: zero is parseable, and it prints.
    for (const env of ["development", "production"]) {
      process.env.NODE_ENV = env;
      expect(formatMoney(0)).toBe("0,00");
      expect(formatMoney("0.00")).toBe("0,00");
      expect(formatMoney(null)).toBe("0,00");
      expect(formatMoney("")).toBe("0,00");
      expect(formatRupiah(0)).toBe("Rp 0,00");
      expect(formatCount(0)).toBe("0");
      expect(formatPercent(0)).toBe("0,00%");
    }
  });
});

describe("angka lain", () => {
  test("formatCount drops the decimals", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1000)).toBe("1.000");
    expect(formatCount("2450")).toBe("2.450");
  });

  test("formatPercent keeps two decimals", () => {
    expect(formatPercent(0)).toBe("0,00%");
    expect(formatPercent(12.5)).toBe("12,50%");
    expect(formatPercent("97.125")).toBe("97,13%");
  });

  test("formatRupiah prefixes the currency", () => {
    expect(formatRupiah(0)).toBe("Rp 0,00");
    expect(formatRupiah(-2500)).toBe("-Rp 2.500,00");
  });

  test("formatDate renders dd-mm-yyyy and tolerates a bad value", () => {
    expect(formatDate("2026-08-23T00:00:00.000Z")).toBe("23-08-2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("bukan tanggal")).toBe("");
  });

  test("formatPeriode spells the month in Indonesian", () => {
    expect(formatPeriode(2026, 8)).toBe("Agustus 2026");
    expect(formatPeriode(2026, 1)).toBe("Januari 2026");
  });
});

describe("parseUang, the input side of the same grammar", () => {
  test("reads the four ways an Indonesian operator writes one figure", () => {
    expect(parseUang("1500000")).toBe("1500000.00");
    expect(parseUang("1.500.000")).toBe("1500000.00");
    expect(parseUang("1.500.000,50")).toBe("1500000.50");
    expect(parseUang("1500000,5")).toBe("1500000.50");
  });

  test("a dot is always a thousands separator here, never a decimal mark", () => {
    // On an Indonesian form "1.500" is fifteen hundred. Guessing per field is
    // how the same keystrokes would mean two different amounts on two screens.
    expect(parseUang("1.500")).toBe("1500.00");
  });

  test("refuses what is not a figure, and refusing is NOT zero", () => {
    expect(parseUang("")).toBeNull();
    expect(parseUang("dua juta")).toBeNull();
    expect(parseUang("1,5,5")).toBeNull();
    expect(parseUang("1000,555")).toBeNull();
    expect(parseUang("-5000")).toBeNull();
    // The caller must refuse to submit rather than send 0,00 for unread text.
    expect(parseUang("abc")).not.toBe("0.00");
  });

  test("round trips through the display format", () => {
    expect(uangKeInput("1500000.50")).toBe("1.500.000,50");
    expect(parseUang(uangKeInput("1500000.50"))).toBe("1500000.50");
    expect(uangKeInput("")).toBe("");
  });

  test("parseRate and formatRate speak the API's six decimal rate", () => {
    expect(parseRate("3")).toBe("3.000000");
    expect(parseRate("3,5")).toBe("3.500000");
    expect(parseRate("3.5")).toBe("3.500000");
    expect(parseRate("tiga")).toBeNull();
    expect(formatRate("3.000000")).toBe("3,00");
  });
});

describe("jumlahkanUang and formatTotal", () => {
  test("adds in integer cents, so a column total actually ties", () => {
    expect(jumlahkanUang(["0.10", "0.20"])).toBe("0.30");
    expect(jumlahkanUang(["25000000.00", "10000000.00"])).toBe("35000000.00");
    expect(jumlahkanUang(["999999999999999.99", "0.01"])).toBe("1000000000000000.00");
  });

  test("a negative value subtracts, which is how a difference is written", () => {
    expect(jumlahkanUang(["15000000.00", "-25000000.00"])).toBe("-10000000.00");
  });

  test("a total over an unreadable value is unknowable, not a partial sum", () => {
    // Silently dropping the bad row would produce a wrong number with nothing
    // on the page admitting it. That is the failure mode UNPARSEABLE exists for.
    expect(jumlahkanUang(["1000.00", "tidak sah"])).toBeNull();
    expect(formatTotal(["1000.00", "rusak"])).toBe(UNPARSEABLE);
    expect(formatTotal(["1000.00", "2000.00"])).toBe("3.000,00");
  });

  test("an empty list totals to a real zero, which still prints 0,00", () => {
    expect(jumlahkanUang([])).toBe("0.00");
    expect(formatTotal([])).toBe("0,00");
  });
});
