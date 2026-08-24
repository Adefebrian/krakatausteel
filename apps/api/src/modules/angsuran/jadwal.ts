// The schedule kernel (spec 7.1). PURE: no database, no clock, no config
// lookup, no side effect of any kind.
//
// WHY IT IS A SEPARATE PURE FILE
// Spec 7.4 and spec 7.5 item 11 require `simulasiJadwal` and `generateJadwal`
// to produce a byte-identical table for identical inputs, and the spec says why
// in as many words: "Wajib memakai engine yang sama dengan generate jadwal,
// jangan duplikasi rumus." The only way to make that structurally true rather
// than hopefully true is one function that both call. This is that function.
// It is also what makes the 500-combination property test cheap: no akad rows,
// no transactions, just arithmetic.
//
// THE ARITHMETIC CONVENTION IS THE ONE PINNED IN ./contract.ts's HEADER.
// BigInt sen, rates as BigInt micro, division truncating toward zero, rows
// 1..n-1 floored to the rounding unit, and the whole accumulated remainder on
// the LAST row, separately for pokok and for jasa. Two consequences are
// intended and are asserted by the tests: `SUM(pokok)` equals the principal
// exactly, and the last row's `total` differs from the others on a rounded
// schedule.
//
// ROWS = grace + tenor (DOCUMENTED CHOICE, spec 7.5 item 5). `tenor_bulan`
// keeps meaning "months of principal repayment", which is what makes
// grace + tenor the quantity the engine compares against
// `batasan.tenor_max_bulan`.
import type {
  BarisJadwal,
  KebijakanJasaGrace,
  MetodePerhitungan,
  RingkasanJadwal,
} from "./contract";
import { bacaUang, bagi, bulatkanBawah, dariSen } from "./uang";

/** Everything the kernel needs, already resolved from akad + konfigurasi. */
export interface ParameterKernel {
  pokokSen: bigint;
  rateMikro: bigint;
  metode: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan: number;
  /** Rounding unit in sen (1n, 10_000n or 100_000n). */
  unitSen: bigint;
  jasaGrace: KebijakanJasaGrace;
  /** 360 or 365. Consulted by EFEKTIF and ANUITAS only. */
  basisHari: number;
  /** ISO date `YYYY-MM-DD` of the first due date. */
  tanggalMulai: string;
  /** 0 = follow the start date's day-of-month; 1..31 = that day every month. */
  hariJatuhTempoTetap: number;
}

export interface HasilKernel {
  baris: BarisJadwal[];
  ringkasan: RingkasanJadwal;
}

/** Fixed-point scale for the annuity factor. 1e12, as pinned by the tests. */
const SKALA = 10n ** 12n;
/** Days in a month, for the day-count basis. 30/360 and 30/365 conventions. */
const HARI_PER_BULAN = 30n;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Days in a month, 1-based month. Handles leap years via UTC day 0. */
function hariDalamBulan(tahun: number, bulan: number): number {
  return new Date(Date.UTC(tahun, bulan, 0)).getUTCDate();
}

/** Parses `YYYY-MM-DD` into its three integer parts. */
export function pecahTanggal(iso: string): { tahun: number; bulan: number; hari: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const tahun = Number(m[1]);
  const bulan = Number(m[2]);
  const hari = Number(m[3]);
  if (bulan < 1 || bulan > 12) return null;
  if (hari < 1 || hari > hariDalamBulan(tahun, bulan)) return null;
  return { tahun, bulan, hari };
}

/**
 * Spec 7.1's due-date rule, and spec 7.5 item 12.
 *
 * The anchor is the DAY OF MONTH (the akad's, or the configured fixed day),
 * never the previous row's date. A month that is too short clamps to its last
 * day, and the row after it RETURNS to the anchor: 31 Jan, 28 Feb, 31 Mar,
 * 30 Apr. Anchoring on the previous row instead gives 31 Jan, 28 Feb, 28 Mar
 * and every later instalment of the loan lands on the wrong day, which is the
 * specific defect angsuran-jadwal.test.ts exists to catch.
 */
export function tanggalJatuhTempo(
  mulai: { tahun: number; bulan: number; hari: number },
  hariTetap: number,
  indeks: number,
): string {
  const jangkar = hariTetap > 0 ? hariTetap : mulai.hari;
  const total = mulai.tahun * 12 + (mulai.bulan - 1) + indeks;
  const tahun = Math.floor(total / 12);
  const bulan = (total % 12) + 1;
  const hari = Math.min(jangkar, hariDalamBulan(tahun, bulan));
  return `${tahun}-${String(bulan).padStart(2, "0")}-${String(hari).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Rate helpers
// ---------------------------------------------------------------------------

/**
 * One month's jasa on a running balance, truncated to the sen:
 * `saldo * rate * 30 / basisHari`. With basisHari 360 this is exactly
 * `saldo * rate / 12`, which is what the FLAT formula uses too; with 365 it is
 * the day-count variant `jasa_adm_basis_hari` exists to select.
 */
function jasaBulanan(saldoSen: bigint, rateMikro: bigint, basisHari: number): bigint {
  if (saldoSen <= 0n || rateMikro === 0n) return 0n;
  return bagi(saldoSen * rateMikro * HARI_PER_BULAN, BigInt(basisHari) * 1_000_000n);
}

/** The monthly rate as fixed point at SKALA, from the same day-count basis. */
function rateBulananSkala(rateMikro: bigint, basisHari: number): bigint {
  return bagi(rateMikro * HARI_PER_BULAN * SKALA, BigInt(basisHari) * 1_000_000n);
}

/**
 * The annuity instalment `A = pokok * i / (1 - (1+i)^-n)`, evaluated on BigInt
 * fixed point at SKALA and truncated to the sen. Rearranged to
 * `pokok * i * P / (P - 1)` with `P = (1+i)^n` so there is no division until
 * the end.
 */
function angsuranAnuitas(pokokSen: bigint, iSkala: bigint, n: number): bigint {
  if (iSkala === 0n) return bagi(pokokSen, BigInt(n));
  let P = SKALA;
  for (let k = 0; k < n; k += 1) P = bagi(P * (SKALA + iSkala), SKALA);
  if (P <= SKALA) return bagi(pokokSen, BigInt(n));
  return bagi(pokokSen * iSkala * P, SKALA * (P - SKALA));
}

// ---------------------------------------------------------------------------
// Grace-period policy
// ---------------------------------------------------------------------------

/**
 * Whether jasa ACCRUES for a grace row (as opposed to being billed on it).
 * ASSUMPTIONS.md A-05: TIDAK_DIHITUNG means no accrual at all, the other two
 * mean it accrues over `grace + tenor` months.
 */
function graceMenambahJasa(kebijakan: KebijakanJasaGrace): boolean {
  return kebijakan !== "TIDAK_DIHITUNG";
}

/** Whether a grace row CARRIES the jasa on its own line. Only DIHITUNG_DIBAYAR does. */
function graceMenagihJasa(kebijakan: KebijakanJasaGrace): boolean {
  return kebijakan === "DIHITUNG_DIBAYAR";
}

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

/**
 * Builds the whole table. The caller has already validated its inputs; this
 * function assumes `tenorBulan >= 1`, `gracePeriodBulan >= 0`,
 * `pokokSen > 0`, a legal rounding unit and a parseable start date, and it
 * never throws a domain error of its own.
 */
export function susunJadwal(p: ParameterKernel): HasilKernel {
  const mulai = pecahTanggal(p.tanggalMulai);
  if (!mulai) throw new Error(`tanggal mulai angsuran tidak valid: ${p.tanggalMulai}`);

  const grace = p.gracePeriodBulan;
  const tenor = p.tenorBulan;
  const n = grace + tenor;
  const unit = p.unitSen;

  const pokokBaris: bigint[] = new Array(n).fill(0n);
  const jasaBaris: bigint[] = new Array(n).fill(0n);
  const saldoSetelah: bigint[] = new Array(n).fill(p.pokokSen);

  // --- pokok and jasa, method by method -----------------------------------
  if (p.metode === "FLAT") {
    // Spec 7.1: pokok_per_bulan = pokok / tenor, total_jasa = pokok * rate *
    // bulan_berjasa / 12, jasa_per_bulan = total_jasa / jumlah_baris_berjasa.
    const bulanBerjasa = graceMenambahJasa(p.jasaGrace) ? n : tenor;
    const targetJasa = bagi(
      p.pokokSen * p.rateMikro * BigInt(bulanBerjasa),
      12n * 1_000_000n,
    );
    const barisBerjasa = graceMenagihJasa(p.jasaGrace) ? n : tenor;
    const jasaPerBaris = bulatkanBawah(bagi(targetJasa, BigInt(barisBerjasa)), unit);
    const pokokPerBaris = bulatkanBawah(bagi(p.pokokSen, BigInt(tenor)), unit);
    const mulaiBerjasa = graceMenagihJasa(p.jasaGrace) ? 0 : grace;

    let terpakaiPokok = 0n;
    let terpakaiJasa = 0n;
    for (let k = 0; k < n - 1; k += 1) {
      if (k >= grace) {
        const bagian = pokokPerBaris > p.pokokSen - terpakaiPokok
          ? p.pokokSen - terpakaiPokok
          : pokokPerBaris;
        pokokBaris[k] = bagian;
        terpakaiPokok += bagian;
      }
      if (k >= mulaiBerjasa) {
        jasaBaris[k] = jasaPerBaris;
        terpakaiJasa += jasaPerBaris;
      }
      saldoSetelah[k] = p.pokokSen - terpakaiPokok;
    }
    // Rule 5: the whole accumulated remainder on the last row, separately for
    // pokok and for jasa.
    pokokBaris[n - 1] = p.pokokSen - terpakaiPokok;
    jasaBaris[n - 1] = targetJasa - terpakaiJasa;
    saldoSetelah[n - 1] = 0n;
  } else {
    const iSkala = rateBulananSkala(p.rateMikro, p.basisHari);
    const anuitas = p.metode === "ANUITAS" ? angsuranAnuitas(p.pokokSen, iSkala, tenor) : 0n;
    const pokokPerBaris = bulatkanBawah(bagi(p.pokokSen, BigInt(tenor)), unit);

    // Pass 1: walk the schedule, accruing jasa on the ROUNDED running balance
    // (rule 7: there is no second, unrounded shadow balance) and billing rows
    // 1..n-1. `targetJasa` is the sum of every row's UNROUNDED accrual, which
    // is what the last row is settled against.
    const akrual: bigint[] = new Array(n).fill(0n);
    let saldo = p.pokokSen;
    let targetJasa = 0n;
    let akrualGrace = 0n;
    for (let k = 0; k < n; k += 1) {
      const dalamGrace = k < grace;
      const akru = dalamGrace && !graceMenambahJasa(p.jasaGrace)
        ? 0n
        : jasaBulanan(saldo, p.rateMikro, p.basisHari);
      akrual[k] = akru;
      targetJasa += akru;
      if (dalamGrace) akrualGrace += akru;

      if (!dalamGrace && k < n - 1) {
        const mentah = p.metode === "ANUITAS" ? anuitas - akru : pokokPerBaris;
        const dibatasi = mentah < 0n ? 0n : mentah > saldo ? saldo : mentah;
        pokokBaris[k] = bulatkanBawah(dibatasi, unit);
        saldo -= pokokBaris[k];
      }
      saldoSetelah[k] = saldo;
    }
    pokokBaris[n - 1] = saldo;
    saldoSetelah[n - 1] = 0n;

    // Pass 2: what each row BILLS. DIHITUNG_DITANGGUHKAN spreads the grace
    // accrual over the post-grace rows, mirroring what FLAT does with the same
    // policy; the truncation remainder lands on the last row with everything
    // else.
    const tangguhan = graceMenagihJasa(p.jasaGrace) || !graceMenambahJasa(p.jasaGrace)
      ? 0n
      : bagi(akrualGrace, BigInt(tenor));
    let terpakaiJasa = 0n;
    for (let k = 0; k < n - 1; k += 1) {
      if (k < grace && !graceMenagihJasa(p.jasaGrace)) continue;
      const mentah = k < grace ? akrual[k] : akrual[k] + tangguhan;
      jasaBaris[k] = bulatkanBawah(mentah, unit);
      terpakaiJasa += jasaBaris[k];
    }
    jasaBaris[n - 1] = targetJasa - terpakaiJasa;
  }

  // --- assemble ------------------------------------------------------------
  const baris: BarisJadwal[] = [];
  for (let k = 0; k < n; k += 1) {
    baris.push({
      angsuranKe: k + 1,
      tanggalJatuhTempo: tanggalJatuhTempo(mulai, p.hariJatuhTempoTetap, k),
      pokok: dariSen(pokokBaris[k]),
      jasaAdm: dariSen(jasaBaris[k]),
      total: dariSen(pokokBaris[k] + jasaBaris[k]),
      saldoPokokSetelah: dariSen(saldoSetelah[k]),
    });
  }

  return { baris, ringkasan: ringkas(baris) };
}

/**
 * Spec 7.4's summary. `angsuranPerBulan` is the `total` of the first row that
 * carries pokok: deliberately not an average, and deliberately not the last
 * row, which absorbs the rounding remainder.
 */
export function ringkas(baris: readonly BarisJadwal[]): RingkasanJadwal {
  let pokok = 0n;
  let jasa = 0n;
  let angsuran = "0.00";
  let sudahKetemu = false;
  for (const b of baris) {
    const up = bacaUang(b.pokok);
    const uj = bacaUang(b.jasaAdm);
    const p = up.bentuk === "ok" ? up.sen : 0n;
    pokok += p;
    jasa += uj.bentuk === "ok" ? uj.sen : 0n;
    if (!sudahKetemu && p > 0n) {
      angsuran = b.total;
      sudahKetemu = true;
    }
  }
  return {
    totalPokok: dariSen(pokok),
    totalJasa: dariSen(jasa),
    totalBayar: dariSen(pokok + jasa),
    angsuranPerBulan: sudahKetemu ? angsuran : baris[baris.length - 1]?.total ?? "0.00",
    jumlahBaris: baris.length,
  };
}

/**
 * The equivalence of docs/BUILD-PLAN.md, on the EFEKTIF_POKOK_RATA basis:
 * an equal-principal declining-balance schedule charges
 * `rate * pokok * (n + 1) / 24`, and a flat schedule charges
 * `rate_flat * pokok * n / 12`, so `rate_flat = rate * (n + 1) / (2n)`.
 * Truncated at six decimals, which is the precision NUMERIC(9,6) stores.
 */
export function rateFlatDariEfektif(rateMikro: bigint, tenorBulan: number): bigint {
  const n = BigInt(tenorBulan);
  return bagi(rateMikro * (n + 1n), 2n * n);
}
