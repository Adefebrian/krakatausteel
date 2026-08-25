// Fixed-precision money, weights and calendar dates for the Non PUMK module.
//
// SAME SEMANTICS AS modules/pumk/uang.ts, modules/jurnal/uang.ts and
// modules/angsuran/uang.ts, and deliberately re-declared rather than imported:
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling
// module's internals and each of those files is internal to its module. The
// rule that follows is that these must not drift, because a sen-level
// difference between two modules' `keSen` is a real bug in a real ledger. When
// a shared money package lands, this file collapses into it.
//
// Every amount that crosses this module is a decimal string with exactly two
// fractional digits (`Uang`); every SDG weight has at most six (`bobot`); all
// arithmetic is on BigInt minor units. There is no `Number`, no `parseFloat`
// and no float division anywhere below (invariant 7).
//
// The parsers answer in shapes rather than throwing, because "not a decimal at
// all" (NILAI_BUKAN_DESIMAL) and "well-formed but out of range"
// (NILAI_DILUAR_BATAS) are DIFFERENT rejections in ./contract.ts's catalogue
// and the caller has to be able to tell them apart.
import type { Uang } from "./contract";

const POLA_DESIMAL_DUA = /^(-?)(\d{1,18})\.(\d{2})$/;
/** A weight or a score: an integer, optionally with up to six decimals. */
const POLA_DESIMAL_ENAM = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/;

export type HasilUang = { bentuk: "rusak" } | { bentuk: "ok"; sen: bigint };

/** Parses an amount. Never throws, never loses a sen. */
export function bacaUang(nilai: unknown): HasilUang {
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

/**
 * A plain decimal scaled to micro units (6 dp), so a threshold written "70"
 * and a score stored "70.000000" compare EXACTLY. Never `Number()`: a ceiling
 * that silently became NaN disables the comparison rather than failing it,
 * which is worse than an outage.
 */
export function keMikro(nilai: unknown): bigint | null {
  if (typeof nilai !== "string") return null;
  const m = POLA_DESIMAL_ENAM.exec(nilai.trim());
  if (!m) return null;
  const besar = BigInt(m[2]) * 1_000_000n + BigInt((m[3] ?? "").padEnd(6, "0"));
  return m[1] === "-" ? -besar : besar;
}

/** Micro units -> a six-decimal string, the shape `bobot` is written with. */
export function dariMikro(mikro: bigint): string {
  const negatif = mikro < 0n;
  const s = (negatif ? -mikro : mikro).toString().padStart(7, "0");
  return `${negatif ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * A real calendar date in 'YYYY-MM-DD'. Rejects 2026-13-01 and 2026-02-30 as
 * well as anything that is not the shape at all: a date Postgres would refuse
 * arrives here as a `22008`, which is a driver string the operator must never
 * see.
 */
export function tanggalValid(nilai: unknown): nilai is string {
  if (typeof nilai !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(nilai)) return false;
  const [t, b, h] = nilai.split("-").map((x) => Number.parseInt(x, 10));
  if (b < 1 || b > 12 || h < 1) return false;
  const hariTerakhir = new Date(Date.UTC(t, b, 0)).getUTCDate();
  return h <= hariTerakhir;
}

/**
 * Whole days between two ISO days, `sampai - dari`. The LPJ ageing of spec 9.2
 * is measured in DAYS, and doing it in UTC midnights rather than on
 * timestamps is what keeps a bucket from moving when the clock crosses a
 * timezone boundary.
 */
export function selisihHari(dari: string, sampai: string): number {
  const ms = Date.parse(`${sampai}T00:00:00.000Z`) - Date.parse(`${dari}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000);
}
