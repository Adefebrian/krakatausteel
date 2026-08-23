import { describe, expect, test } from "bun:test";
import {
  formatCount,
  formatDate,
  formatMoney,
  formatPercent,
  formatPeriode,
  formatRupiah,
} from "./money";

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

  test("never prints NaN for an unparseable value", () => {
    expect(formatMoney(Number.NaN)).toBe("0,00");
    expect(formatMoney("bukan angka")).toBe("0,00");
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
