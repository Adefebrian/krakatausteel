// Fixed-precision money arithmetic for the ledger.
//
// Every amount crossing this module is a decimal string with exactly two
// fractional digits (`Uang` in ./contract.ts). Arithmetic happens on BigInt
// minor units and nowhere else: `parseFloat` and `Number` are banned here,
// because invariant 1 ("SUM(debit) = SUM(kredit) persis, tanpa toleransi")
// cannot survive an IEEE-754 double, and NUMERIC(20,2) reaches past
// Number.MAX_SAFE_INTEGER anyway.
//
// The three-way answer of `bacaUang` is deliberate: "malformed" and "negative"
// are DIFFERENT rejections in spec 6.2 (validation 4 vs the contract's
// NILAI_BUKAN_DESIMAL), so the parser must be able to tell a well-formed
// negative amount from a value that is not a decimal at all.
import type { Uang } from "./contract";

/** Well-formed two-decimal amount, optionally negative. */
const POLA_DESIMAL_DUA = /^(-?)(\d{1,18})\.(\d{2})$/;

export type HasilUang =
  | { bentuk: "rusak" }
  | { bentuk: "ok"; sen: bigint; negatif: boolean };

/** Parses an amount. Never throws, never loses a sen. */
export function bacaUang(nilai: string | null | undefined): HasilUang {
  if (nilai === null || nilai === undefined) return { bentuk: "ok", sen: 0n, negatif: false };
  const m = POLA_DESIMAL_DUA.exec(nilai);
  if (!m) return { bentuk: "rusak" };
  const besaran = BigInt(m[2] + m[3]);
  const negatif = m[1] === "-" && besaran !== 0n;
  return { bentuk: "ok", sen: negatif ? -besaran : besaran, negatif };
}

/** Minor units -> `Uang`. `dariSen(0n)` === "0.00". */
export function dariSen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const s = (negatif ? -minor : minor).toString().padStart(3, "0");
  return `${negatif ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Sum of already-parsed minor units. Present for symmetry with the tests' helpers. */
export function totalSen(nilai: readonly bigint[]): bigint {
  return nilai.reduce((a, b) => a + b, 0n);
}
