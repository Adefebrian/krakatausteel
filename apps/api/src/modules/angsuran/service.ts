// The instalment engine (spec 7). The single implementation site behind
// `createAngsuranEngine` in ./contract.ts.
//
// WHAT THIS FILE OWNS AND WHAT THE DATABASE OWNS
// ADR 0002 makes Postgres the last line of defence for the receivable
// invariants: a generated schedule is immutable in its priced columns, exactly
// one version per akad is active, version 1's total pokok equals the akad's
// principal (a DEFERRED constraint trigger), a schedule row can never be
// overpaid, a deposit is fully accounted for, and `0 <= outstanding_pokok`.
// None of that is duplicated here to be clever; it is re-checked here so the
// CALLER gets a domain error with a sentence instead of a trigger string, and
// so a rejected schedule never leaves a half-written version behind. Spec 7.1
// is explicit about one of them: "Assert ini di kode, jangan hanya di test."
// When the database refuses anyway, ./kesalahan.ts maps the refusal onto the
// same code.
//
// WHAT IS DELIBERATELY NOT IN THIS FILE
//   - No account codes and no journal rows. Every automatic journal's accounts
//     come from `event_jurnal_mapping` (invariant 11), so this engine hands an
//     EVENT CODE plus a sub-ledger dimension to `PorterJurnalAngsuran` and
//     never names an account. Spec 7.2 step 8 needs one journal with several
//     lines, which is why the port is a COMBINED posting rather than
//     `postingEvent` called three times.
//   - No policy numbers. The rounding unit, the grace-jasa policy, the
//     day-count basis, the allocation order, the due-day option, the tenor and
//     plafon ceilings and the flat-rate derivation switch are all read from
//     `konfigurasi` on every call. In particular the grace-jasa default is
//     CONTESTED (spec 7.1 says "jasa dibayar", ASSUMPTIONS.md A-05 and
//     migrations/0004 say TIDAK_DIHITUNG), so this engine reads the row and
//     never carries a default of its own.
//   - No formula duplication. ./jadwal.ts is the one kernel, called by both
//     `generateJadwal` and `simulasiJadwal` (spec 7.4, spec 7.5 item 11).
//
// TRANSACTION DISCIPLINE
// Every mutating method runs inside exactly one `db.transaction`. Spec 7.2 is
// explicit ("Seluruh langkah 1 sampai 8 dalam satu transaksi database. Kalau
// jurnal gagal, alokasi harus rollback"), spec 7.3 flips a version off and
// writes a whole new one, and the total-pokok guards are DEFERRED constraint
// triggers that only raise at COMMIT.
import {
  AngsuranError,
  type AjukanRescheduleInput,
  type AngsuranContext,
  type AngsuranEngine,
  type AngsuranEngineDeps,
  type AngsuranTx,
  type BarisJadwal,
  type GenerateJadwalInput,
  type HasilAlokasi,
  type HasilPemulihanAkrual,
  type HasilReschedule,
  type Jadwal,
  type KebijakanJasaGrace,
  type KomponenAlokasi,
  type KomponenJurnal,
  type KonversiRateInput,
  type MetodePerhitungan,
  type ParameterTerpakai,
  type RateTahunan,
  type Reschedule,
  type RincianAlokasiBaris,
  type SetoranInput,
  type SimulasiInput,
  type StatusAkad,
  type TabelJadwal,
  type Uang,
} from "./contract";
import { alokasikan, type BarisTerbuka } from "./alokasi";
import {
  bagiJasaSetoran,
  tempatkanAkrual,
  type BagianBarisJasa,
  type KapasitasAkrual,
} from "./alokasi-akrual";
import { rateFlatDariEfektif, ringkas, susunJadwal, pecahTanggal } from "./jadwal";
import { bersihkanKesalahan, tolak } from "./kesalahan";
import { createAngsuranRepo, type AkadBaris, type AngsuranRepo, type JadwalBaris } from "./repo";
import { bacaRate, bacaUang, dariMikro, dariSen } from "./uang";

/**
 * The permission codes this engine checks, mirroring `PERMISSION_ANGSURAN` in
 * ./contract.ts plus `pumk.view` for reading the kartu piutang.
 *
 * WRITTEN AS STRING LITERALS ON PURPOSE, not spread from that constant:
 * ./contract.ts imports this file, so reading one of its runtime bindings at
 * module-evaluation time here throws "Cannot access before initialization".
 * ./kesalahan.ts's message catalogue is written with literal keys for exactly
 * the same reason. The two lists must not drift; the values are asserted by
 * the authorisation tests in this folder.
 */
const PERMISSION = {
  LIHAT: "pumk.view",
  GENERATE_JADWAL: "pumk.akad",
  SETORAN: "pumk.angsuran",
  RESCHEDULE_AJUKAN: "pumk.reschedule",
  RESCHEDULE_SETUJUI: "pumk.approve",
} as const;

/** Statuses that can still receive money or be restructured (spec 8.4 check 10). */
const STATUS_PIUTANG_AKTIF = new Set<string>(["AKTIF", "RESCHEDULED", "MACET"]);

const KOMPONEN_WAJIB: KomponenAlokasi[] = [
  "TUNGGAKAN_JASA",
  "TUNGGAKAN_POKOK",
  "JASA_BERJALAN",
  "POKOK_BERJALAN",
  "KELEBIHAN",
];

const METODE_DIKENAL = new Set<string>(["FLAT", "EFEKTIF", "ANUITAS"]);
const KEBIJAKAN_GRACE = new Set<string>([
  "TIDAK_DIHITUNG",
  "DIHITUNG_DITANGGUHKAN",
  "DIHITUNG_DIBAYAR",
]);

// ---------------------------------------------------------------------------
// Authorisation (spec 2)
// ---------------------------------------------------------------------------

/** Spec 2: "Sistem harus menolak, bukan hanya menyembunyikan tombol." */
function wajibPermission(ctx: AngsuranContext, kode: string): void {
  if (!ctx.permissions.includes(kode)) throw tolak("TIDAK_BERWENANG", { permission: kode });
}

/** Spec 2.3: a user acts on their own branch, or on one explicitly in scope. */
function wajibScope(ctx: AngsuranContext, cabangId: string): void {
  if (cabangId === ctx.cabangId) return;
  if (ctx.cabangDalamScope?.includes(cabangId)) return;
  throw tolak("CABANG_DILUAR_SCOPE", { cabangId });
}

// ---------------------------------------------------------------------------
// Configuration, read on every call and never defaulted in code
// ---------------------------------------------------------------------------

interface KonfigurasiAngsuran {
  pembulatan: number;
  unitSen: bigint;
  jasaGrace: KebijakanJasaGrace;
  basisHari: number;
  hariJatuhTempoTetap: number;
  presetAlokasi: string;
  tenorMaxBulan: number;
  graceMaxBulan: number;
  turunkanFlatDariEfektif: boolean;
  rateAcuanMikro: bigint | null;
  plafonMinSen: bigint | null;
  plafonMaxSen: bigint | null;
}

const UNIT: Record<string, bigint> = { "0": 1n, "100": 10_000n, "1000": 100_000n };

function bilanganBulat(nilai: string | null, kunci: string): number {
  if (nilai === null || nilai.trim() === "") throw tolak("KONFIGURASI_TIDAK_ADA", { kunci });
  if (!/^\d+$/.test(nilai.trim())) throw tolak("KONFIGURASI_TIDAK_VALID", { kunci, nilai });
  return Number(nilai.trim());
}

async function bacaKonfigurasi(
  repo: AngsuranRepo,
  tx: AngsuranTx,
  bumnId: string,
): Promise<KonfigurasiAngsuran> {
  const ambil = (grup: string, kunci: string) => repo.konfigurasi(tx, bumnId, grup, kunci);

  const mentahPembulatan = await ambil("angsuran", "pembulatan_angsuran");
  if (mentahPembulatan === null) {
    throw tolak("KONFIGURASI_TIDAK_ADA", { kunci: "angsuran.pembulatan_angsuran" });
  }
  const unitSen = UNIT[mentahPembulatan.trim()];
  if (unitSen === undefined) {
    // A config row an operator can type into must never silently become a
    // rounding unit nobody specified.
    throw tolak("PEMBULATAN_TIDAK_VALID", { nilai: mentahPembulatan });
  }

  const mentahGrace = (await ambil("akuntansi", "jasa_grace_period"))?.trim() ?? null;
  if (mentahGrace === null || mentahGrace === "") {
    throw tolak("KONFIGURASI_TIDAK_ADA", { kunci: "akuntansi.jasa_grace_period" });
  }
  if (!KEBIJAKAN_GRACE.has(mentahGrace)) {
    throw tolak("KONFIGURASI_TIDAK_VALID", { kunci: "akuntansi.jasa_grace_period", nilai: mentahGrace });
  }

  const mentahBasis = (await ambil("jasa_adm", "jasa_adm_basis_hari"))?.trim() ?? null;
  if (mentahBasis === null || mentahBasis === "") {
    throw tolak("KONFIGURASI_TIDAK_ADA", { kunci: "jasa_adm.jasa_adm_basis_hari" });
  }
  if (mentahBasis !== "360" && mentahBasis !== "365") {
    throw tolak("KONFIGURASI_TIDAK_VALID", { kunci: "jasa_adm.jasa_adm_basis_hari", nilai: mentahBasis });
  }

  const hariTetap = bilanganBulat(
    await ambil("angsuran", "hari_jatuh_tempo_tetap"),
    "angsuran.hari_jatuh_tempo_tetap",
  );
  if (hariTetap > 31) {
    throw tolak("KONFIGURASI_TIDAK_VALID", {
      kunci: "angsuran.hari_jatuh_tempo_tetap",
      nilai: hariTetap,
    });
  }

  const preset = (await ambil("angsuran", "urutan_alokasi_setoran_preset"))?.trim() ?? "";
  if (preset === "") {
    throw tolak("KONFIGURASI_TIDAK_ADA", { kunci: "angsuran.urutan_alokasi_setoran_preset" });
  }

  const tenorMaxBulan = bilanganBulat(
    await ambil("batasan", "tenor_max_bulan"),
    "batasan.tenor_max_bulan",
  );
  const graceMaxBulan = bilanganBulat(
    await ambil("batasan", "grace_period_max_bulan"),
    "batasan.grace_period_max_bulan",
  );

  const mentahSwitch = (await ambil("jasa_adm", "turunkan_flat_dari_efektif"))?.trim() ?? null;
  if (mentahSwitch === null || (mentahSwitch !== "true" && mentahSwitch !== "false")) {
    throw tolak("KONFIGURASI_TIDAK_VALID", {
      kunci: "jasa_adm.turunkan_flat_dari_efektif",
      nilai: mentahSwitch,
    });
  }
  const turunkanFlat = mentahSwitch === "true";

  // Only parsed when the switch is on: a blank cell must stop the calculation
  // rather than fall back to the akad's rate, which is the very value the
  // switch exists to override.
  let rateAcuanMikro: bigint | null = null;
  if (turunkanFlat) {
    const mentahRate = (await ambil("jasa_adm", "rate_efektif_acuan"))?.trim() ?? "";
    const rate = bacaRate(mentahRate);
    if (mentahRate === "" || rate.bentuk === "rusak") {
      throw tolak("KONFIGURASI_TIDAK_VALID", {
        kunci: "jasa_adm.rate_efektif_acuan",
        nilai: mentahRate,
      });
    }
    rateAcuanMikro = rate.mikro;
  }

  const plafonMinSen = uangKonfigurasi(await ambil("batasan", "plafon_min_pumk"), "batasan.plafon_min_pumk");
  const plafonMaxSen = uangKonfigurasi(await ambil("batasan", "plafon_max_pumk"), "batasan.plafon_max_pumk");

  // WHICH jasa event applies is DELIBERATELY NOT READ FROM CONFIGURATION.
  //
  // It used to be: `akuntansi.metode_pengakuan_jasa_adm` alone chose the event
  // for the whole receipt. That is the defect migrations/0030 closes. The cell
  // ships as ACCRUAL, so every receipt posted ANGSURAN_JASA_ADM_AKRUAL, which
  // CREDITS Piutang Jasa Administrasi on the assumption the receivable already
  // exists; but an instalment paid in the month it falls due is never accrued
  // (the close computes `jasa_jatuh_tempo - jasa_diterima`, which nets to
  // zero), so nothing ever DEBITED it. Piutang Jasa Administrasi went negative
  // and the income was never recognised, on a balance sheet that still
  // balanced because both halves were missing.
  //
  // The event now follows the FACT, not the policy cell: each schedule row
  // carries `jasa_akrual_belum_tertagih`, written by the accrual engine, so
  // the receipt asks the row itself how much of its jasa is already sitting in
  // 1.1.04. That answers the config question as a consequence rather than as a
  // separate rule: under CASH_BASIS nothing is ever accrued, every row reads
  // zero, and every receipt is direct income exactly as before. It also gets
  // the two cases a config cell cannot see: an akad whose kolektibilitas is
  // outside `akrual_hanya_untuk_kolektibilitas` is never accrued, and a config
  // flipped from ACCRUAL to CASH_BASIS still has to collect the receivables it
  // already booked. See OPEN-QUESTIONS item 3, which asked for exactly this
  // ("per rupiah"), and ./alokasi-akrual.ts for the split itself.

  return {
    pembulatan: Number(mentahPembulatan.trim()),
    unitSen,
    jasaGrace: mentahGrace as KebijakanJasaGrace,
    basisHari: Number(mentahBasis),
    hariJatuhTempoTetap: hariTetap,
    presetAlokasi: preset,
    tenorMaxBulan,
    graceMaxBulan,
    turunkanFlatDariEfektif: turunkanFlat,
    rateAcuanMikro,
    plafonMinSen,
    plafonMaxSen,
  };
}

/** A money-typed config cell. Absent is tolerated; malformed is not. */
function uangKonfigurasi(nilai: string | null, kunci: string): bigint | null {
  if (nilai === null || nilai.trim() === "") return null;
  const u = bacaUang(nilai.trim());
  if (u.bentuk === "rusak") throw tolak("KONFIGURASI_TIDAK_VALID", { kunci, nilai });
  return u.sen;
}

// ---------------------------------------------------------------------------
// Input validation shared by generation and simulation
// ---------------------------------------------------------------------------

interface ParameterMentah {
  pokok: Uang;
  rate: RateTahunan;
  metode: string;
  tenorBulan: number;
  gracePeriodBulan: number;
  tanggalMulaiAngsuran: string;
}

interface ParameterTervalidasi {
  pokokSen: bigint;
  rateMikro: bigint;
  metode: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan: number;
  tanggalMulai: string;
}

function validasiParameter(
  p: ParameterMentah,
  cfg: KonfigurasiAngsuran,
  opsi: { periksaPlafon: boolean },
): ParameterTervalidasi {
  const pokok = bacaUang(p.pokok);
  if (pokok.bentuk === "rusak") throw tolak("NILAI_BUKAN_DESIMAL", { pokok: p.pokok });
  if (pokok.sen <= 0n) throw tolak("POKOK_TIDAK_VALID", { pokok: p.pokok });

  const rate = bacaRate(p.rate);
  if (rate.bentuk === "rusak") throw tolak("NILAI_BUKAN_DESIMAL", { rate: p.rate });

  if (!Number.isInteger(p.tenorBulan) || p.tenorBulan <= 0) {
    throw tolak("TENOR_TIDAK_VALID", { tenorBulan: p.tenorBulan });
  }
  if (!Number.isInteger(p.gracePeriodBulan) || p.gracePeriodBulan < 0) {
    throw tolak("GRACE_DILUAR_BATAS", { gracePeriodBulan: p.gracePeriodBulan });
  }
  if (!METODE_DIKENAL.has(p.metode)) throw tolak("METODE_TIDAK_DIKENAL", { metode: p.metode });
  if (!pecahTanggal(p.tanggalMulaiAngsuran)) {
    throw tolak("TANGGAL_TIDAK_VALID", { tanggalMulaiAngsuran: p.tanggalMulaiAngsuran });
  }

  if (p.gracePeriodBulan > cfg.graceMaxBulan) {
    throw tolak("GRACE_DILUAR_BATAS", {
      gracePeriodBulan: p.gracePeriodBulan,
      batas: cfg.graceMaxBulan,
    });
  }
  // DOCUMENTED CHOICE (spec 7.5 item 5): rows = grace + tenor, so grace + tenor
  // is what the 36-month ceiling of PER-1/MBU/03/2023 pasal 22(2) applies to.
  if (p.gracePeriodBulan + p.tenorBulan > cfg.tenorMaxBulan) {
    throw tolak("TENOR_DILUAR_BATAS", {
      gracePeriodBulan: p.gracePeriodBulan,
      tenorBulan: p.tenorBulan,
      batas: cfg.tenorMaxBulan,
    });
  }

  if (opsi.periksaPlafon) {
    if (cfg.plafonMinSen !== null && pokok.sen < cfg.plafonMinSen) {
      throw tolak("POKOK_DILUAR_PLAFON", { pokok: p.pokok, min: dariSen(cfg.plafonMinSen) });
    }
    if (cfg.plafonMaxSen !== null && pokok.sen > cfg.plafonMaxSen) {
      throw tolak("POKOK_DILUAR_PLAFON", { pokok: p.pokok, max: dariSen(cfg.plafonMaxSen) });
    }
  }

  return {
    pokokSen: pokok.sen,
    rateMikro: rate.mikro,
    metode: p.metode as MetodePerhitungan,
    tenorBulan: p.tenorBulan,
    gracePeriodBulan: p.gracePeriodBulan,
    tanggalMulai: p.tanggalMulaiAngsuran,
  };
}

/**
 * The rate actually applied. When `turunkan_flat_dari_efektif` is on, a FLAT
 * schedule uses the flat rate DERIVED from the reference effective rate rather
 * than the one typed on the akad: docs/REGULASI.md finding 1 reads
 * PER-1/MBU/03/2023 pasal 22(2) as 3 percent EFEKTIF or an equivalent flat
 * rate, so a flat 3 percent typed into a form is the non-compliant reading.
 * EFEKTIF and ANUITAS are already effective methods and are left alone.
 */
function rateTerpakai(p: ParameterTervalidasi, cfg: KonfigurasiAngsuran): bigint {
  if (!cfg.turunkanFlatDariEfektif || p.metode !== "FLAT" || cfg.rateAcuanMikro === null) {
    return p.rateMikro;
  }
  return rateFlatDariEfektif(cfg.rateAcuanMikro, p.tenorBulan);
}

/** Builds the table plus the echo of the parameters that produced it. */
function hitungTabel(p: ParameterTervalidasi, cfg: KonfigurasiAngsuran): TabelJadwal {
  const rateMikro = rateTerpakai(p, cfg);
  const hasil = susunJadwal({
    pokokSen: p.pokokSen,
    rateMikro,
    metode: p.metode,
    tenorBulan: p.tenorBulan,
    gracePeriodBulan: p.gracePeriodBulan,
    unitSen: cfg.unitSen,
    jasaGrace: cfg.jasaGrace,
    basisHari: cfg.basisHari,
    tanggalMulai: p.tanggalMulai,
    hariJatuhTempoTetap: cfg.hariJatuhTempoTetap,
  });

  const parameterTerpakai: ParameterTerpakai = {
    pokok: dariSen(p.pokokSen),
    rate: dariMikro(rateMikro),
    metode: p.metode,
    tenorBulan: p.tenorBulan,
    gracePeriodBulan: p.gracePeriodBulan,
    pembulatan: cfg.pembulatan,
    jasaGrace: cfg.jasaGrace,
    basisHari: cfg.basisHari,
    hariJatuhTempoTetap: cfg.hariJatuhTempoTetap,
  };

  return { baris: hasil.baris, ringkasan: hasil.ringkasan, parameterTerpakai };
}

/**
 * Spec 7.1's non-negotiable total, asserted in code and not only in a test:
 * `SUM(pokok)` must equal the principal the schedule is for. Catching it here
 * means the caller gets a sentence instead of the deferred trigger's raw
 * TJSL-JDW-001 text at COMMIT.
 */
function wajibTotalPokok(baris: readonly BarisJadwal[], pokokSen: bigint): void {
  let total = 0n;
  for (const b of baris) {
    const u = bacaUang(b.pokok);
    total += u.bentuk === "ok" ? u.sen : 0n;
  }
  if (total !== pokokSen) {
    throw tolak("TOTAL_POKOK_TIDAK_COCOK", {
      totalJadwal: dariSen(total),
      pokok: dariSen(pokokSen),
    });
  }
  const terakhir = baris[baris.length - 1];
  if (!terakhir || terakhir.saldoPokokSetelah !== "0.00") {
    throw tolak("TOTAL_POKOK_TIDAK_COCOK", { saldoAkhir: terakhir?.saldoPokokSetelah ?? null });
  }
}

function senDari(nilai: string): bigint {
  const u = bacaUang(nilai);
  if (u.bentuk === "rusak") throw tolak("NILAI_BUKAN_DESIMAL", { nilai });
  return u.sen;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function buatEngineAngsuran(deps: AngsuranEngineDeps): AngsuranEngine {
  const repo = createAngsuranRepo();
  const sekarang = () => deps.jam?.() ?? new Date();

  /** Writes a whole version: the header, then every row, inside one transaction. */
  async function simpanVersi(
    tx: AngsuranTx,
    akadId: string,
    versi: number,
    tabel: TabelJadwal,
    rescheduleId: string | null,
    keterangan: string | null,
    userId: string,
  ): Promise<void> {
    await repo.buatVersi(tx, {
      akadId,
      versi,
      tanggalBerlaku: tabel.baris[0]?.tanggalJatuhTempo ?? null,
      rescheduleId,
      keterangan,
      userId,
    });
    for (const b of tabel.baris) {
      await repo.buatBarisJadwal(tx, {
        akadId,
        versi,
        angsuranKe: b.angsuranKe,
        tanggalJatuhTempo: b.tanggalJatuhTempo,
        pokok: b.pokok,
        jasaAdm: b.jasaAdm,
        total: b.total,
        saldoPokokSetelah: b.saldoPokokSetelah,
        userId,
      });
    }
  }

  /** Rebuilds a stored version as a `Jadwal`, for the kartu piutang (spec 9.1). */
  function jadwalDariBaris(
    akad: AkadBaris,
    versi: number,
    aktif: boolean,
    baris: JadwalBaris[],
    cfg: KonfigurasiAngsuran,
  ): Jadwal {
    const rows: BarisJadwal[] = baris.map((b) => ({
      angsuranKe: b.angsuran_ke,
      tanggalJatuhTempo: b.tanggal_jatuh_tempo,
      pokok: b.pokok,
      jasaAdm: b.jasa_adm,
      total: b.total,
      saldoPokokSetelah: b.saldo_pokok_setelah,
    }));
    let grace = 0;
    while (grace < rows.length && rows[grace].pokok === "0.00") grace += 1;
    const totalPokok = rows.reduce((acc, r) => acc + senDari(r.pokok), 0n);
    // The parameters are RECONSTRUCTED from the stored rows plus the akad and
    // the current configuration: `pumk_jadwal_versi` records no parameter
    // echo, so a historical version cannot claim more precision than this.
    const parameterTerpakai: ParameterTerpakai = {
      pokok: dariSen(totalPokok),
      rate: akad.jasa_adm_rate,
      metode: akad.metode_perhitungan as MetodePerhitungan,
      tenorBulan: rows.length - grace,
      gracePeriodBulan: grace,
      pembulatan: cfg.pembulatan,
      jasaGrace: cfg.jasaGrace,
      basisHari: cfg.basisHari,
      hariJatuhTempoTetap: cfg.hariJatuhTempoTetap,
    };
    return {
      akadId: akad.id,
      versi,
      isActiveVersion: aktif,
      baris: rows,
      ringkasan: ringkas(rows),
      parameterTerpakai,
    };
  }

  return {
    async generateJadwal(input: GenerateJadwalInput, ctx: AngsuranContext): Promise<Jadwal> {
      wajibPermission(ctx, PERMISSION.GENERATE_JADWAL);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akadUntukDiubah(tx, input.akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
          wajibScope(ctx, akad.cabang_id);
          if (akad.status === "LUNAS" || akad.status === "HAPUS_BUKU") {
            throw tolak("AKAD_TIDAK_BISA_DIANGSUR", { status: akad.status });
          }
          // Invariant 8: a generated schedule is immutable, so the only legal
          // route to a different one is a reschedule creating a new version.
          if ((await repo.versiTerbesar(tx, akad.id)) !== null) {
            throw tolak("JADWAL_SUDAH_ADA", { akadId: akad.id });
          }

          const cfg = await bacaKonfigurasi(repo, tx, akad.bumn_id);
          const param = validasiParameter(
            {
              pokok: akad.pokok_pinjaman,
              rate: akad.jasa_adm_rate,
              metode: akad.metode_perhitungan,
              tenorBulan: akad.tenor_bulan,
              gracePeriodBulan: akad.grace_period_bulan,
              tanggalMulaiAngsuran: akad.tanggal_mulai_angsuran,
            },
            cfg,
            { periksaPlafon: true },
          );

          const tabel = hitungTabel(param, cfg);
          wajibTotalPokok(tabel.baris, param.pokokSen);

          await simpanVersi(tx, akad.id, 1, tabel, null, "Jadwal awal akad (spec 7.1)", ctx.userId);

          return { ...tabel, akadId: akad.id, versi: 1, isActiveVersion: true };
        }),
      );
    },

    async simulasiJadwal(input: SimulasiInput, ctx: AngsuranContext): Promise<TabelJadwal> {
      // Spec 7.4: reachable without a proposal and without an akad, so it
      // stores nothing, posts nothing and opens no transaction. It reads the
      // SAME configuration and calls the SAME kernel, which is what makes
      // spec 7.5 item 11's identity structural rather than hopeful.
      return bersihkanKesalahan(async () => {
        const cfg = await bacaKonfigurasi(repo, deps.db, ctx.bumnId);
        const param = validasiParameter(
          {
            pokok: input.pokok,
            rate: input.rate,
            metode: input.metode,
            tenorBulan: input.tenorBulan,
            gracePeriodBulan: input.gracePeriodBulan,
            tanggalMulaiAngsuran: input.tanggalMulaiAngsuran,
          },
          cfg,
          { periksaPlafon: false },
        );
        const tabel = hitungTabel(param, cfg);
        wajibTotalPokok(tabel.baris, param.pokokSen);
        return tabel;
      });
    },

    async alokasikanSetoran(input: SetoranInput, ctx: AngsuranContext): Promise<HasilAlokasi> {
      wajibPermission(ctx, PERMISSION.SETORAN);
      const jumlah = bacaUang(input.jumlah);
      if (jumlah.bentuk === "rusak") throw tolak("NILAI_BUKAN_DESIMAL", { jumlah: input.jumlah });
      if (jumlah.sen <= 0n) throw tolak("SETORAN_TIDAK_POSITIF", { jumlah: input.jumlah });
      if (!pecahTanggal(input.tanggal)) {
        throw tolak("TANGGAL_TIDAK_VALID", { tanggal: input.tanggal });
      }
      const valuta = input.tanggalValuta ?? null;
      if (valuta !== null && !pecahTanggal(valuta)) {
        throw tolak("TANGGAL_TIDAK_VALID", { tanggalValuta: valuta });
      }

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akadUntukDiubah(tx, input.akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
          wajibScope(ctx, akad.cabang_id);
          if (!STATUS_PIUTANG_AKTIF.has(akad.status)) {
            throw tolak("AKAD_TIDAK_BISA_DIANGSUR", { status: akad.status });
          }
          if (!(await repo.versiAktif(tx, akad.id))) {
            throw tolak("JADWAL_TIDAK_DITEMUKAN", { akadId: akad.id });
          }

          const akun = await repo.akun(tx, input.akunKasId);
          if (!akun || !akun.aktif || !akun.is_kas || !akun.is_postable) {
            throw tolak("AKUN_KAS_TIDAK_VALID", { akunKasId: input.akunKasId });
          }
          if (akun.bumn_id !== akad.bumn_id) {
            throw tolak("AKUN_KAS_TIDAK_VALID", { akunKasId: input.akunKasId });
          }

          const cfg = await bacaKonfigurasi(repo, tx, akad.bumn_id);

          // Step 3: the order comes from `alokasi_setoran_preset`, with no
          // built-in fallback. A preset an operator mistyped must stop the
          // allocation, not quietly apply a rule nobody chose.
          const urutan = (await repo.presetAlokasi(tx, cfg.presetAlokasi)) as KomponenAlokasi[];
          if (urutan.length === 0) {
            throw tolak("PRESET_ALOKASI_TIDAK_DITEMUKAN", { preset: cfg.presetAlokasi });
          }
          for (const wajib of KOMPONEN_WAJIB) {
            if (!urutan.includes(wajib)) {
              throw tolak("PRESET_ALOKASI_TIDAK_LENGKAP", { preset: cfg.presetAlokasi, komponen: wajib });
            }
          }

          // Steps 1 and 2.
          const barisTerbukaDb = await repo.barisBelumLunas(tx, akad.id);
          const terbuka: BarisTerbuka[] = barisTerbukaDb.map((b) => ({
            jadwalId: b.id,
            angsuranKe: b.angsuran_ke,
            tanggalJatuhTempo: b.tanggal_jatuh_tempo,
            status: b.status as BarisTerbuka["status"],
            pokokSen: senDari(b.pokok),
            jasaSen: senDari(b.jasa_adm),
            pokokTerbayarSen: senDari(b.pokok_terbayar),
            jasaTerbayarSen: senDari(b.jasa_terbayar),
          }));
          // migrations/0030: how much of each row's jasa is ALREADY sitting in
          // Piutang Jasa Administrasi. Read here, from the same locked rows the
          // waterfall walks, so nothing can accrue or be collected in between.
          const akrualPerBaris = new Map(
            barisTerbukaDb.map((b) => [b.id, senDari(b.jasa_akrual_belum_tertagih)]),
          );

          const hasil = alokasikan(terbuka, urutan, jumlah.sen, input.tanggal);

          // THE CLASSIFICATION, per rupiah rather than per configuration cell.
          // See the note in `bacaKonfigurasi` for what this replaced and why.
          const bagian = bagiJasaSetoran(
            hasil.baris.map((b) => ({
              jadwalId: b.jadwalId,
              tambahJasaSen: b.tambahJasaSen,
              akrualTersediaSen: akrualPerBaris.get(b.jadwalId) ?? 0n,
            })),
          );
          const bagianPerBaris = new Map<string, BagianBarisJasa>(
            bagian.baris.map((b) => [b.jadwalId, b]),
          );

          // Step 6, computed by subtraction rather than by re-summing the
          // rows: after a reschedule the paid rows live on a superseded
          // version, so "principal minus what the active version has been paid"
          // would silently forget every instalment paid before the restructure.
          const outstandingPokok = senDari(akad.outstanding_pokok) - hasil.pokokSen;
          const outstandingJasa = senDari(akad.outstanding_jasa) - hasil.jasaSen;
          if (outstandingPokok < 0n || outstandingJasa < 0n) {
            throw tolak("OUTSTANDING_NEGATIF", {
              outstandingPokok: dariSen(outstandingPokok),
              outstandingJasa: dariSen(outstandingJasa),
            });
          }

          // Step 4. `jasaAkrualBelumTertagih` rides along in the SAME
          // statement as `jasaTerbayar`: pumk_jadwal_akrual_ck relates the two,
          // so writing them separately would fail on an intermediate row that
          // no caller ever asked for.
          for (const b of hasil.baris) {
            const sisaAkrual =
              bagianPerBaris.get(b.jadwalId)?.sisaAkrualSen ??
              akrualPerBaris.get(b.jadwalId) ??
              0n;
            await repo.perbaruiPembayaranBaris(tx, {
              jadwalId: b.jadwalId,
              pokokTerbayar: dariSen(b.pokokTerbayarSen),
              jasaTerbayar: dariSen(b.jasaTerbayarSen),
              status: b.statusSetelah,
              tanggalLunas: b.lunas ? input.tanggal : null,
              jasaAkrualBelumTertagih: dariSen(sisaAkrual),
              userId: ctx.userId,
            });
          }

          const angsuranId = await repo.buatAngsuran(tx, {
            akadId: akad.id,
            tanggal: input.tanggal,
            tanggalValuta: valuta,
            jumlah: dariSen(jumlah.sen),
            alokasiPokok: dariSen(hasil.pokokSen),
            alokasiJasa: dariSen(hasil.jasaSen),
            alokasiKelebihan: dariSen(hasil.kelebihanSen),
            akunKasId: input.akunKasId,
            noBukti: input.noBukti ?? null,
            metodeAlokasi: cfg.presetAlokasi,
            keterangan: input.keterangan ?? null,
            userId: ctx.userId,
          });

          // The provenance of every rupiah of receivable this receipt cleared,
          // so a reversal can put back exactly what was taken instead of
          // recomputing an approximation onto whichever row looks plausible
          // later (migrations/0030).
          await repo.catatKonsumsiAkrual(tx, {
            angsuranId,
            userId: ctx.userId,
            baris: bagian.baris
              .filter((b) => b.pakaiAkrualSen > 0n)
              .map((b) => ({ jadwalId: b.jadwalId, nilai: dariSen(b.pakaiAkrualSen) })),
          });

          // Step 5: invariant 10. A surplus becomes a liability, never a
          // negative receivable.
          const kelebihanId =
            hasil.kelebihanSen > 0n
              ? await repo.buatKelebihan(tx, {
                  akadId: akad.id,
                  angsuranId,
                  tanggal: input.tanggal,
                  jumlah: dariSen(hasil.kelebihanSen),
                  userId: ctx.userId,
                })
              : null;

          // Step 7.
          const lunas = outstandingPokok === 0n && outstandingJasa === 0n;
          const statusBaru: StatusAkad = lunas ? "LUNAS" : (akad.status as StatusAkad);
          const tanggalLunas = lunas ? input.tanggal : akad.tanggal_lunas;
          await repo.perbaruiOutstanding(tx, {
            akadId: akad.id,
            outstandingPokok: dariSen(outstandingPokok),
            outstandingJasa: dariSen(outstandingJasa),
            status: statusBaru,
            tanggalLunas,
            userId: ctx.userId,
          });

          // Step 8: ONE journal with several lines, not three journals. The
          // accounts come from `event_jurnal_mapping` on the other side of this
          // port (invariant 11), so what crosses it is an event code and a
          // sub-ledger dimension, never an account id.
          const komponen: KomponenJurnal[] = [];
          if (hasil.pokokSen > 0n) {
            komponen.push({
              eventCode: "ANGSURAN_POKOK",
              nilai: dariSen(hasil.pokokSen),
              mitraId: akad.mitra_id,
              akadId: akad.id,
            });
          }
          // THE SUB-LEDGER DIMENSION GOES ON THE POKOK COMPONENT ONLY.
          // Spec 6.2 validation 8, enforced by the journal engine as
          // DIMENSI_PIUTANG_SALAH_AKUN: a line carrying a Mitra Binaan or an
          // akad may only use the Piutang Pinjaman Mitra Binaan account. The
          // jasa leg lands on Pendapatan Jasa Administrasi or on Piutang Jasa
          // Administrasi, and the surplus leg on Kelebihan Pembayaran
          // Angsuran, so tagging those with a mitra would make the whole
          // journal illegal and roll the allocation back.
          // TWO LEGS, NOT ONE, WHEN THE RECEIPT GENUINELY NEEDS BOTH. A
          // partial payment against a row that was partly accrued clears the
          // receivable up to what was accrued and recognises the rest as
          // income; those are two different accounts, so they are two
          // components of the SAME journal (spec 7.2 step 8 forbids a second
          // journal, not a second line). `bagian.akrualSen + bagian.langsungSen`
          // is `hasil.jasaSen` by construction, so the cash leg still balances.
          if (bagian.akrualSen > 0n) {
            komponen.push({
              eventCode: "ANGSURAN_JASA_ADM_AKRUAL",
              nilai: dariSen(bagian.akrualSen),
            });
          }
          if (bagian.langsungSen > 0n) {
            komponen.push({ eventCode: "ANGSURAN_JASA_ADM", nilai: dariSen(bagian.langsungSen) });
          }
          if (hasil.kelebihanSen > 0n) {
            komponen.push({
              eventCode: "TERIMA_KELEBIHAN_ANGSURAN",
              nilai: dariSen(hasil.kelebihanSen),
            });
          }

          let jurnalId: string;
          try {
            const posting = await deps.jurnal.postingEventGabungan(
              {
                cabangId: akad.cabang_id,
                tanggalTransaksi: valuta ?? input.tanggal,
                komponen,
                keterangan: input.keterangan ?? `Angsuran akad ${akad.no_akad}`,
                referensiTipe: "pumk_angsuran",
                referensiId: angsuranId,
                akunKasId: input.akunKasId,
                kunciIdempotensi: `pumk_angsuran:${angsuranId}`,
              },
              tx,
              ctx,
            );
            jurnalId = posting.jurnalId;
          } catch (err) {
            // "Kalau jurnal gagal, alokasi harus rollback": throwing here
            // aborts the transaction, and the driver/trigger text stays in
            // penyebabDb instead of reaching the caller.
            if (err instanceof AngsuranError) throw err;
            throw tolak(
              "JURNAL_GAGAL",
              { angsuranId },
              err instanceof Error ? err.message : String(err),
            );
          }

          await repo.setJurnalAngsuran(tx, angsuranId, jurnalId);
          if (kelebihanId) await repo.setJurnalKelebihan(tx, kelebihanId, jurnalId);

          const rincian: RincianAlokasiBaris[] = hasil.baris.map((b) => ({
            jadwalId: b.jadwalId,
            angsuranKe: b.angsuranKe,
            pokokDialokasikan: dariSen(b.tambahPokokSen),
            jasaDialokasikan: dariSen(b.tambahJasaSen),
            statusSetelah: b.statusSetelah,
          }));

          return {
            angsuranId,
            jumlahDiterima: dariSen(jumlah.sen),
            alokasiPokok: dariSen(hasil.pokokSen),
            alokasiJasa: dariSen(hasil.jasaSen),
            alokasiJasaAkrual: dariSen(bagian.akrualSen),
            alokasiJasaLangsung: dariSen(bagian.langsungSen),
            alokasiKelebihan: dariSen(hasil.kelebihanSen),
            rincian,
            urutanKomponenDipakai: urutan,
            jurnalId,
            kelebihanId,
            akadSetelah: {
              outstandingPokok: dariSen(outstandingPokok),
              outstandingJasa: dariSen(outstandingJasa),
              status: statusBaru,
              tanggalLunas: lunas ? input.tanggal : akad.tanggal_lunas,
            },
          };
        }),
      );
    },

    async pulihkanAkrualSetoran(
      angsuranId: string,
      ctx: AngsuranContext,
    ): Promise<HasilPemulihanAkrual> {
      // Same permission as making the receipt: giving a receivable back is the
      // same class of act as consuming it, and neither is a read.
      wajibPermission(ctx, PERMISSION.SETORAN);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const setoran = await repo.angsuran(tx, angsuranId);
          if (!setoran) throw tolak("AKAD_TIDAK_DITEMUKAN", { angsuranId });
          const akad = await repo.akadUntukDiubah(tx, setoran.akad_id);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: setoran.akad_id });
          wajibScope(ctx, akad.cabang_id);

          const konsumsi = (await repo.konsumsiAkrual(tx, angsuranId)).filter(
            (k) => k.dipulihkan_at === null,
          );
          // IDEMPOTENT BY CONSTRUCTION, not by a flag the caller has to check:
          // the second call sees every row already marked and gives back
          // nothing. A reversal that ran twice must not double the receivable.
          if (konsumsi.length === 0) {
            return { angsuranId, totalDipulihkan: dariSen(0n), perBaris: [] };
          }

          const baris = await repo.barisAktif(tx, akad.id);
          const aktif = new Map(baris.map((b) => [b.id, b]));
          const sisaSekarang = new Map(
            baris.map((b) => [b.id, senDari(b.jasa_akrual_belum_tertagih)]),
          );
          const kapasitas = (jadwalId: string): bigint => {
            const b = aktif.get(jadwalId);
            if (!b) return 0n;
            return (
              senDari(b.jasa_adm) - senDari(b.jasa_terbayar) - (sisaSekarang.get(jadwalId) ?? 0n)
            );
          };

          let belumDitempatkanSen = 0n;
          for (const k of konsumsi) {
            const nilai = senDari(k.nilai);
            // ONTO THE ORIGINAL ROW FIRST. That row is where the accrual was,
            // so restoring it there is the only placement that reconstructs
            // the exact state the receipt found. It only fails to be available
            // when a reschedule has since retired the version, and a retired
            // row can hold nothing an allocation would ever reach.
            const muat = kapasitas(k.jadwal_id);
            const langsung = nilai < muat ? nilai : muat;
            if (langsung > 0n) {
              sisaSekarang.set(k.jadwal_id, (sisaSekarang.get(k.jadwal_id) ?? 0n) + langsung);
            }
            belumDitempatkanSen += nilai - langsung;
          }

          if (belumDitempatkanSen > 0n) {
            const penempatan = tempatkanAkrual(
              baris.map<KapasitasAkrual>((b) => ({ jadwalId: b.id, kapasitasSen: kapasitas(b.id) })),
              belumDitempatkanSen,
            );
            if (penempatan.sisaSen > 0n) {
              // The rows cannot hold a receivable the ledger already carries.
              // Refuse, for the same reason a reschedule refuses: the only
              // honest alternative is a write-off journal nobody has specified.
              throw tolak("AKRUAL_TIDAK_TERTAMPUNG", {
                angsuranId,
                tidakTertampung: dariSen(penempatan.sisaSen),
              });
            }
            for (const t of penempatan.penempatan) {
              sisaSekarang.set(t.jadwalId, (sisaSekarang.get(t.jadwalId) ?? 0n) + t.tambahSen);
            }
          }

          const perBaris: HasilPemulihanAkrual["perBaris"] = [];
          let total = 0n;
          for (const b of baris) {
            const sebelum = senDari(b.jasa_akrual_belum_tertagih);
            const sesudah = sisaSekarang.get(b.id) ?? sebelum;
            if (sesudah === sebelum) continue;
            await repo.setAkrualBaris(tx, {
              jadwalId: b.id,
              nilai: dariSen(sesudah),
              userId: ctx.userId,
            });
            total += sesudah - sebelum;
            perBaris.push({ jadwalId: b.id, nilai: dariSen(sesudah - sebelum) });
          }

          await repo.tandaiKonsumsiDipulihkan(
            tx,
            konsumsi.map((k) => k.id),
            ctx.userId,
          );

          return { angsuranId, totalDipulihkan: dariSen(total), perBaris };
        }),
      );
    },

    async ajukanReschedule(
      input: AjukanRescheduleInput,
      ctx: AngsuranContext,
    ): Promise<Reschedule> {
      wajibPermission(ctx, PERMISSION.RESCHEDULE_AJUKAN);
      if (!input.alasan || input.alasan.trim() === "") throw tolak("ALASAN_WAJIB");
      if (!pecahTanggal(input.tanggalPengajuan)) {
        throw tolak("TANGGAL_TIDAK_VALID", { tanggalPengajuan: input.tanggalPengajuan });
      }
      if (input.tenorBaru !== null && input.tenorBaru !== undefined) {
        if (!Number.isInteger(input.tenorBaru) || input.tenorBaru <= 0) {
          throw tolak("TENOR_TIDAK_VALID", { tenorBaru: input.tenorBaru });
        }
      }
      if (input.graceBaru !== null && input.graceBaru !== undefined) {
        if (!Number.isInteger(input.graceBaru) || input.graceBaru < 0) {
          throw tolak("GRACE_DILUAR_BATAS", { graceBaru: input.graceBaru });
        }
      }
      if (input.jasaRateBaru !== null && input.jasaRateBaru !== undefined) {
        if (bacaRate(input.jasaRateBaru).bentuk === "rusak") {
          throw tolak("NILAI_BUKAN_DESIMAL", { jasaRateBaru: input.jasaRateBaru });
        }
      }
      // SEAM, deliberately closed rather than half-open: migrations/0019 added
      // pumk_reschedule.pokok_baru and made the principal-changing branch of
      // spec 7.3 item 7 representable, but the correction journal it demands
      // (trg_pumk_reschedule_50_koreksi, and jurnal_id_koreksi's FK to jurnal)
      // needs an event code that spec 6.4 does not list, and
      // AjukanRescheduleInput carries no new principal. Guessing an event
      // mapping for a money movement is exactly the kind of silent decision
      // this engine refuses to make, so a principal restructure is rejected
      // with a sentence until the accounting team names the event.
      if (input.jenis === "RESTRUKTUR_POKOK") {
        throw tolak("POKOK_TIDAK_VALID", {
          jenis: input.jenis,
          sebab: "restruktur pokok belum punya event jurnal koreksi yang diputuskan",
        });
      }

      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const akad = await repo.akad(tx, input.akadId);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: input.akadId });
          wajibScope(ctx, akad.cabang_id);
          if (!STATUS_PIUTANG_AKTIF.has(akad.status)) {
            throw tolak("AKAD_TIDAK_BISA_DIANGSUR", { status: akad.status });
          }
          const versi = await repo.versiAktif(tx, akad.id);
          if (!versi) throw tolak("JADWAL_TIDAK_DITEMUKAN", { akadId: akad.id });

          const cfg = await bacaKonfigurasi(repo, tx, akad.bumn_id);
          const grace = input.graceBaru ?? 0;
          const belumLunas = (await repo.barisBelumLunas(tx, akad.id)).length;
          const tenor = input.tenorBaru ?? Math.max(belumLunas, 1);
          if (grace > cfg.graceMaxBulan) {
            throw tolak("GRACE_DILUAR_BATAS", { graceBaru: grace, batas: cfg.graceMaxBulan });
          }
          if (grace + tenor > cfg.tenorMaxBulan) {
            throw tolak("TENOR_DILUAR_BATAS", {
              tenorBaru: tenor,
              graceBaru: grace,
              batas: cfg.tenorMaxBulan,
            });
          }

          const id = await repo.buatReschedule(tx, {
            akadId: akad.id,
            tanggalPengajuan: input.tanggalPengajuan,
            alasan: input.alasan.trim(),
            jenis: input.jenis,
            tenorBaru: input.tenorBaru ?? null,
            graceBaru: input.graceBaru ?? null,
            jasaRateBaru: input.jasaRateBaru ?? null,
            pokokBaru: null,
            jadwalVersiLama: versi.versi,
            catatan: input.catatan ?? null,
            userId: ctx.userId,
          });

          return {
            id,
            akadId: akad.id,
            status: "DRAFT" as const,
            jenis: input.jenis,
            jadwalVersiLama: versi.versi,
            jadwalVersiBaru: null,
            tenorBaru: input.tenorBaru ?? null,
            graceBaru: input.graceBaru ?? null,
            jasaRateBaru: input.jasaRateBaru ?? null,
          };
        }),
      );
    },

    async setujuiReschedule(
      rescheduleId: string,
      ctx: AngsuranContext,
    ): Promise<HasilReschedule> {
      wajibPermission(ctx, PERMISSION.RESCHEDULE_SETUJUI);
      return bersihkanKesalahan(() =>
        deps.db.transaction(async (tx) => {
          const r = await repo.reschedule(tx, rescheduleId);
          if (!r) throw tolak("RESCHEDULE_TIDAK_DITEMUKAN", { rescheduleId });
          if (r.status !== "DRAFT") {
            throw tolak("RESCHEDULE_SUDAH_DIPROSES", { status: r.status });
          }
          // Spec 2 rule 1: reject, do not merely hide the button.
          if (r.created_by && r.created_by === ctx.userId) {
            throw tolak("APPROVER_TIDAK_BOLEH_MAKER", { rescheduleId });
          }

          const akad = await repo.akadUntukDiubah(tx, r.akad_id);
          if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId: r.akad_id });
          wajibScope(ctx, akad.cabang_id);
          if (!STATUS_PIUTANG_AKTIF.has(akad.status)) {
            throw tolak("AKAD_TIDAK_BISA_DIANGSUR", { status: akad.status });
          }

          const versiLamaBaris = await repo.barisJadwal(tx, akad.id, r.jadwal_versi_lama);
          if (versiLamaBaris.length === 0) {
            throw tolak("JADWAL_TIDAK_DITEMUKAN", { akadId: akad.id, versi: r.jadwal_versi_lama });
          }

          // Step 2: the basis is the outstanding as it stands now, frozen onto
          // the reschedule row so the new version stays reconstructable.
          const outstandingPokok = senDari(akad.outstanding_pokok);
          const outstandingJasa = senDari(akad.outstanding_jasa);
          if (outstandingPokok <= 0n) {
            throw tolak("POKOK_TIDAK_VALID", { outstandingPokok: akad.outstanding_pokok });
          }

          // WHERE THE NEW VERSION'S DUE DATES START, which spec 7.3 does not
          // say: at the EARLIEST UNPAID due date of the version being
          // superseded. Dating it from the approval instead would silently
          // forgive the instalment already in arrears.
          const belumLunas = versiLamaBaris.filter((b) => b.status !== "LUNAS");
          const mulai =
            belumLunas.length > 0
              ? belumLunas.reduce(
                  (min, b) => (b.tanggal_jatuh_tempo < min ? b.tanggal_jatuh_tempo : min),
                  belumLunas[0].tanggal_jatuh_tempo,
                )
              : akad.tanggal_mulai_angsuran;

          const cfg = await bacaKonfigurasi(repo, tx, akad.bumn_id);
          const grace = r.grace_baru ?? 0;
          const tenor = r.tenor_baru ?? Math.max(belumLunas.length, 1);
          const param = validasiParameter(
            {
              pokok: dariSen(outstandingPokok),
              rate: r.jasa_rate_baru ?? akad.jasa_adm_rate,
              metode: akad.metode_perhitungan,
              tenorBulan: tenor,
              gracePeriodBulan: grace,
              tanggalMulaiAngsuran: mulai,
            },
            cfg,
            { periksaPlafon: false },
          );

          const tabel = hitungTabel(param, cfg);
          wajibTotalPokok(tabel.baris, param.pokokSen);

          const versiBaru = (await repo.versiTerbesar(tx, akad.id) ?? r.jadwal_versi_lama) + 1;

          // The reschedule row first: the DISETUJUI CHECK needs
          // jadwal_versi_baru and outstanding_pokok_sebelum in the same
          // statement, and the deferred TJSL-JDW-006 reads the basis from here.
          const diproses = await repo.setujuiReschedule(tx, {
            id: r.id,
            versiBaru,
            outstandingPokokSebelum: dariSen(outstandingPokok),
            outstandingJasaSebelum: dariSen(outstandingJasa),
            userId: ctx.userId,
            waktu: sekarang().toISOString(),
          });
          if (diproses === 0) throw tolak("RESCHEDULE_SUDAH_DIPROSES", { rescheduleId: r.id });

          // ACCRUED JASA IS MONEY ALREADY IN THE LEDGER, SO IT MOVES WITH THE
          // RESTRUCTURE (migrations/0030). The superseded version's rows carry
          // whatever the closing engine accrued into Piutang Jasa Administrasi
          // and nobody has collected yet. Retiring the version without moving
          // that balance would strand a receivable no future receipt could
          // ever clear, because allocation only ever walks the ACTIVE version:
          // the debit would sit in 1.1.04 forever and every later collection
          // would be booked as income a second time.
          let akrualTerbawaSen = 0n;
          for (const b of versiLamaBaris) {
            const sisa = senDari(b.jasa_akrual_belum_tertagih);
            if (sisa <= 0n) continue;
            akrualTerbawaSen += sisa;
            await repo.setAkrualBaris(tx, {
              jadwalId: b.id,
              nilai: dariSen(0n),
              userId: ctx.userId,
            });
          }

          // Step 3, before the new version exists: pumk_jadwal_versi_aktif_uq
          // allows exactly one active version per akad. The row-level flag and
          // the DIRESCHEDULE status of the unpaid rows are propagated by
          // trg_pumk_jadwal_versi_50_propagasi, which leaves LUNAS rows alone
          // (step 5).
          await repo.nonaktifkanVersi(tx, {
            akadId: akad.id,
            versi: r.jadwal_versi_lama,
            rescheduleId: r.id,
            userId: ctx.userId,
          });

          // Step 4.
          await simpanVersi(
            tx,
            akad.id,
            versiBaru,
            tabel,
            r.id,
            `Reschedule ${r.jenis} (spec 7.3)`,
            ctx.userId,
          );

          // ...and lands on the new version, earliest row first. A remainder
          // means the restructured schedule carries LESS jasa than has already
          // been recognised as income and booked as a receivable, which is a
          // WAIVER: it needs a correcting journal, and spec 6.4 lists no event
          // for one. Same seam, and the same answer, as RESTRUKTUR_POKOK
          // above: refuse with a sentence rather than quietly write the
          // receivable off.
          if (akrualTerbawaSen > 0n) {
            const barisBaru = await repo.barisAktif(tx, akad.id);
            const kapasitas: KapasitasAkrual[] = barisBaru.map((b) => ({
              jadwalId: b.id,
              kapasitasSen:
                senDari(b.jasa_adm) -
                senDari(b.jasa_terbayar) -
                senDari(b.jasa_akrual_belum_tertagih),
            }));
            const penempatan = tempatkanAkrual(kapasitas, akrualTerbawaSen);
            if (penempatan.sisaSen > 0n) {
              throw tolak("AKRUAL_TIDAK_TERTAMPUNG", {
                akadId: akad.id,
                akrualDibawa: dariSen(akrualTerbawaSen),
                tidakTertampung: dariSen(penempatan.sisaSen),
                jasaJadwalBaru: tabel.ringkasan.totalJasa,
              });
            }
            const sisaAwal = new Map(barisBaru.map((b) => [b.id, senDari(b.jasa_akrual_belum_tertagih)]));
            for (const t of penempatan.penempatan) {
              await repo.setAkrualBaris(tx, {
                jadwalId: t.jadwalId,
                nilai: dariSen((sisaAwal.get(t.jadwalId) ?? 0n) + t.tambahSen),
                userId: ctx.userId,
              });
            }
          }

          // Step 6: RESCHEDULED is still an active receivable. The new
          // version's jasa replaces the superseded version's remaining jasa,
          // while the principal basis is unchanged (step 7: no journal).
          const jasaBaru = senDari(tabel.ringkasan.totalJasa);
          await repo.perbaruiOutstanding(tx, {
            akadId: akad.id,
            outstandingPokok: dariSen(outstandingPokok),
            outstandingJasa: dariSen(jasaBaru),
            status: "RESCHEDULED",
            tanggalLunas: akad.tanggal_lunas,
            userId: ctx.userId,
          });

          const terbayarHistoris = senDari(akad.pokok_pinjaman) - outstandingPokok;

          return {
            reschedule: {
              id: r.id,
              akadId: akad.id,
              status: "DISETUJUI" as const,
              jenis: r.jenis as Reschedule["jenis"],
              jadwalVersiLama: r.jadwal_versi_lama,
              jadwalVersiBaru: versiBaru,
              tenorBaru: r.tenor_baru,
              graceBaru: r.grace_baru,
              jasaRateBaru: r.jasa_rate_baru,
            },
            versiLama: r.jadwal_versi_lama,
            versiBaru,
            jadwalBaru: {
              ...tabel,
              akadId: akad.id,
              versi: versiBaru,
              isActiveVersion: true,
            },
            // Step 7: a term extension moves nothing between accounts, so
            // there is no journal. The principal-changing branch is the seam
            // documented on ajukanReschedule.
            jurnalId: null,
            pokokTerbayarHistoris: dariSen(terbayarHistoris),
            outstandingBaru: dariSen(outstandingPokok),
          };
        }),
      );
    },

    rateFlatEkuivalen(input: KonversiRateInput): RateTahunan {
      const basis = input.basis ?? "EFEKTIF_POKOK_RATA";
      if (basis !== "EFEKTIF_POKOK_RATA") {
        // docs/REGULASI.md finding 3: which definition of "efektif" applies is
        // the client accounting team's open decision, and the wrong guess
        // changes what every mitra binaan is billed. Fail closed.
        throw tolak("BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN", { basis });
      }
      const rate = bacaRate(input.rateEfektif);
      if (rate.bentuk === "rusak") {
        throw tolak("NILAI_BUKAN_DESIMAL", { rateEfektif: input.rateEfektif });
      }
      if (!Number.isInteger(input.tenorBulan) || input.tenorBulan <= 0) {
        throw tolak("TENOR_TIDAK_VALID", { tenorBulan: input.tenorBulan });
      }
      return dariMikro(rateFlatDariEfektif(rate.mikro, input.tenorBulan));
    },

    async riwayatJadwal(akadId: string, ctx: AngsuranContext): Promise<Jadwal[]> {
      wajibPermission(ctx, PERMISSION.LIHAT);
      return bersihkanKesalahan(async () => {
        const akad = await repo.akad(deps.db, akadId);
        if (!akad) throw tolak("AKAD_TIDAK_DITEMUKAN", { akadId });
        wajibScope(ctx, akad.cabang_id);
        const cfg = await bacaKonfigurasi(repo, deps.db, akad.bumn_id);
        const versi = await repo.semuaVersi(deps.db, akadId);
        const semuaBaris = await repo.barisJadwal(deps.db, akadId);
        return versi.map((v) =>
          jadwalDariBaris(
            akad,
            v.versi,
            v.is_active_version,
            semuaBaris.filter((b) => b.versi === v.versi),
            cfg,
          ),
        );
      });
    },
  };
}
