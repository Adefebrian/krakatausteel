// Fixed-precision money, rates and calendar dates for the PUMK module.
//
// SAME SEMANTICS AS modules/jurnal/uang.ts AND modules/angsuran/uang.ts, and
// deliberately re-declared rather than imported: `bun tools/check-boundaries.ts`
// forbids a deep import into a sibling module's internals, and those two files
// are internal to their modules. The rule that follows is that these must not
// drift, because a sen-level difference between two modules' `keSen` is a real
// bug in a real ledger. When a shared test/money package lands, this file
// collapses into it.
//
// Every amount that crosses this module is a decimal string with exactly two
// fractional digits (`Uang`); every rate has exactly six (`RateTahunan`); all
// arithmetic is on BigInt minor units. There is no `Number`, no `parseFloat`
// and no float division anywhere below (invariant 7).
//
// The parsers answer in three shapes rather than throwing, because "not a
// decimal at all" (NILAI_BUKAN_DESIMAL) and "well-formed but out of range"
// (PLAFON_DILUAR_BATAS) are DIFFERENT rejections in ./contract.ts's catalogue
// and the caller has to be able to tell them apart.
import type { RateTahunan, Uang } from "./contract";

const POLA_DESIMAL_DUA = /^(-?)(\d{1,18})\.(\d{2})$/;
const POLA_DESIMAL_ENAM = /^(\d{1,3})\.(\d{6})$/;

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

export type HasilRate = { bentuk: "rusak" } | { bentuk: "ok"; mikro: bigint };

/** Parses a rate into micro units (6 dp). "0.030000" -> 30000n. */
export function bacaRate(nilai: unknown): HasilRate {
  if (typeof nilai !== "string") return { bentuk: "rusak" };
  const m = POLA_DESIMAL_ENAM.exec(nilai);
  if (!m) return { bentuk: "rusak" };
  return { bentuk: "ok", mikro: BigInt(m[1]) * 1_000_000n + BigInt(m[2]) };
}

/** Micro units -> `RateTahunan`. */
export function dariMikro(mikro: bigint): RateTahunan {
  const s = mikro.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * A real calendar date in 'YYYY-MM-DD'. Rejects 2026-13-01 and 2026-02-30 as
 * well as anything that is not the shape at all: a date that Postgres would
 * refuse arrives here as a `22008`, which is a driver string the operator must
 * never see.
 */
export function tanggalValid(nilai: unknown): nilai is string {
  if (typeof nilai !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(nilai)) return false;
  const [t, b, h] = nilai.split("-").map((x) => Number.parseInt(x, 10));
  if (b < 1 || b > 12 || h < 1) return false;
  const hariTerakhir = new Date(Date.UTC(t, b, 0)).getUTCDate();
  return h <= hariTerakhir;
}

/**
 * Adds whole months, clamping to the end of the target month (31 Jan plus one
 * month is 28/29 Feb). The SAME rule the schedule kernel uses, so an akad's
 * `tanggal_jatuh_tempo_akhir` cannot disagree with the last row of the
 * schedule generated from it for an incidental reason.
 */
export function tambahBulan(iso: string, bulan: number): string {
  const [t, b, h] = iso.split("-").map((x) => Number.parseInt(x, 10));
  const totalBulan = b - 1 + bulan;
  const tahunBaru = t + Math.floor(totalBulan / 12);
  const bulanBaru = ((totalBulan % 12) + 12) % 12;
  const hariTerakhir = new Date(Date.UTC(tahunBaru, bulanBaru + 1, 0)).getUTCDate();
  const hariBaru = Math.min(h, hariTerakhir);
  return `${tahunBaru}-${String(bulanBaru + 1).padStart(2, "0")}-${String(hariBaru).padStart(2, "0")}`;
}
