// Fixed-precision money and rate arithmetic for the instalment engine.
//
// Same posture as modules/jurnal/uang.ts, and deliberately the same semantics:
// every amount that crosses this module is a decimal string with exactly two
// fractional digits (`Uang`), every rate is a decimal string with exactly six
// (`RateTahunan`), and ALL arithmetic happens on BigInt minor units. There is
// no `Number`, no `parseFloat` and no float division anywhere in the schedule
// kernel, because spec 7.1 requires `SUM(pokok)` to equal the principal to the
// sen and an IEEE-754 double cannot promise that inside NUMERIC(20,2)'s range.
//
// The parser answers in three shapes rather than throwing, for the same reason
// the journal's does: "not a decimal at all" (NILAI_BUKAN_DESIMAL) and
// "well-formed but out of range" (POKOK_TIDAK_VALID, RATE_TIDAK_VALID) are
// DIFFERENT rejections in ./contract.ts's catalogue, so the caller has to be
// able to tell them apart.
import type { RateTahunan, Uang } from "./contract";

/** Well-formed two-decimal amount, optionally negative. */
const POLA_DESIMAL_DUA = /^(-?)(\d{1,18})\.(\d{2})$/;
/** Well-formed six-decimal rate. Never negative: NUMERIC(9,6) CHECK >= 0. */
const POLA_DESIMAL_ENAM = /^(\d{1,3})\.(\d{6})$/;

export type HasilUang = { bentuk: "rusak" } | { bentuk: "ok"; sen: bigint };

/** Parses an amount. Never throws, never loses a sen. */
export function bacaUang(nilai: string | null | undefined): HasilUang {
  if (typeof nilai !== "string") return { bentuk: "rusak" };
  const m = POLA_DESIMAL_DUA.exec(nilai);
  if (!m) return { bentuk: "rusak" };
  const besaran = BigInt(m[2] + m[3]);
  return { bentuk: "ok", sen: m[1] === "-" ? -besaran : besaran };
}

/** Minor units -> `Uang`. `dariSen(0n)` === "0.00". */
export function dariSen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const s = (negatif ? -minor : minor).toString().padStart(3, "0");
  return `${negatif ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

export type HasilRate = { bentuk: "rusak" } | { bentuk: "ok"; mikro: bigint };

/** Parses a rate into micro units (6 dp). "0.030000" -> 30000n. */
export function bacaRate(nilai: string | null | undefined): HasilRate {
  if (typeof nilai !== "string") return { bentuk: "rusak" };
  const m = POLA_DESIMAL_ENAM.exec(nilai);
  if (!m) return { bentuk: "rusak" };
  return { bentuk: "ok", mikro: BigInt(m[1]) * 1_000_000n + BigInt(m[2]) };
}

/** Micro units -> `RateTahunan`. */
export function dariMikro(mikro: bigint): RateTahunan {
  if (mikro < 0n) throw new Error(`rate tidak boleh negatif: ${mikro}`);
  const s = mikro.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * Floors a non-negative amount to a rounding unit. `unit` is 1n when
 * `pembulatan_angsuran` is 0, so this is a no-op in that case rather than a
 * branch every caller has to remember.
 */
export function bulatkanBawah(sen: bigint, unit: bigint): bigint {
  if (unit <= 1n || sen <= 0n) return sen > 0n ? sen : 0n;
  return sen - (sen % unit);
}

/** Truncating division toward zero, for non-negative operands. */
export function bagi(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("pembagian dengan nol di kernel angsuran");
  return a / b;
}
